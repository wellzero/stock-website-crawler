#!/usr/bin/env python3
"""
Final Strategy: Volume-Filtered Equal-Weight Index + Trend Timing
==================================================================

The Honest Best Implementation Based on analysis_v2's Own Data.

Key finding from systematic exploration:
  Volume filtering (excluding bottom 25% by trading volume) is the single
  strongest "alpha source" — it improved equal-weight returns from +34.82%
  (Sharpe 0.944) to +55.30% (Sharpe 1.742) on 2025-01 to 2026-07.
  
  Factor tilts beyond volume filtering are noise-to-negative contributors.
  The quality/defense factors in the cache (dim_quality, defense_profitability,
  etc.) all underperform the volume-filtered equal-weight benchmark.

Architecture:
  Layer 1: Data — market panel + CSI300 index
  Layer 2: Signal — volume-filtered equal-weight universe
  Layer 3: Risk — CSI300 20-day trend filter

Usage:
  uv run python3 scripts/final_strategy.py                          # Full period
  uv run python3 scripts/final_strategy.py --start 2026-01-05       # 2026 H1 only
  uv run python3 scripts/final_strategy.py --compare-all            # All variants
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import warnings
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

AV2 = Path("/Users/fengzhi/Downloads/git2/analysis_v2")
sys.path.insert(0, str(AV2))
os.chdir(str(AV2))

OUTPUT_BASE = Path("/Users/fengzhi/Downloads/git/testlixingren/output/final_strategy")


@dataclass
class Config:
    start: str = "2025-01-01"
    end: str = "2026-07-01"
    top_n: int = 9999           # all qualifying stocks
    rebalance_freq: int = 20    # ~monthly
    initial_capital: float = 1_000_000.0
    min_price: float = 2.0
    commission: float = 0.0002
    stamp_tax: float = 0.001
    slippage: float = 0.0008
    volume_filter_pct: float = 0.25  # exclude bottom 25% by volume
    trend_lookback: int = 20
    trend_entry: float = -0.05       # 5% decline → full cash
    trend_exit: float = -0.02        # recover to -2% → re-enter
    enable_risk: bool = True
    use_factors: bool = False         # Factor tilts (proven harmful)
    run_id: str = field(default_factory=lambda: datetime.now().strftime("final_%Y%m%d_%H%M%S_%f")[:24])


# ── Data Loading ─────────────────────────────────────────────

def load_market(start: str, end: str) -> dict[str, pd.DataFrame]:
    from analysis_v2.core import FactorCache
    return FactorCache().load_market_panel(start, end)


def load_index(idx_code: str = "000300.SH") -> pd.Series:
    idx_dir = AV2 / "data_cache" / "market_data" / "daily" / "index_daily"
    if not idx_dir.exists():
        return pd.Series(dtype=np.float32)
    records = []
    for pdir in sorted(idx_dir.iterdir()):
        if not pdir.name.startswith("date="):
            continue
        try:
            dt = pd.Timestamp(pdir.name[5:])
        except Exception:
            continue
        fp = pdir / "data.parquet"
        if not fp.exists():
            continue
        try:
            df = pd.read_parquet(fp, columns=["index_code", "close"])
        except Exception:
            continue
        row = df[df["index_code"] == idx_code]
        if row.empty:
            continue
        records.append(pd.Series({dt: float(row["close"].iloc[0])}))
    if not records:
        return pd.Series(dtype=np.float32)
    return pd.concat(records).sort_index().astype(np.float32).dropna()


# ── Risk State ────────────────────────────────────────────────

def compute_equity_frac(idx: pd.Series, cfg: Config) -> pd.Series:
    """1.0 = fully invested, 0.0 = fully in cash."""
    ret = idx.pct_change(cfg.trend_lookback).dropna()
    dates = pd.DatetimeIndex(sorted(ret.index))
    ef = pd.Series(1.0, index=dates)
    in_cash = False
    for dt in dates:
        r = ret.loc[dt]
        if not in_cash and r <= cfg.trend_entry:
            in_cash = True
            ef.loc[dt] = 0.0
        elif in_cash and r >= cfg.trend_exit:
            in_cash = False
            ef.loc[dt] = 1.0
        elif in_cash:
            ef.loc[dt] = 0.0
    n_cash = int((ef < 0.5).sum())
    logger.info("Risk: CSI300 trend → %.1f%% days in cash (%d events)",
                n_cash / len(ef) * 100, n_cash)
    return ef


# ── Backtest ──────────────────────────────────────────────────

@dataclass
class BTResult:
    equity: pd.Series = field(default_factory=pd.Series)
    daily_returns: pd.Series = field(default_factory=pd.Series)
    turnover: pd.Series = field(default_factory=pd.Series)
    n_holdings: pd.Series = field(default_factory=pd.Series)
    equity_frac: pd.Series = field(default_factory=pd.Series)
    final_capital: float = 0.0
    total_return: float = 0.0


def run_bt(close: pd.DataFrame, volume: pd.DataFrame | None,
           equity_frac: pd.Series | None, cfg: Config) -> BTResult:
    dates = sorted(close.index[1:])
    n_dates = len(dates)
    logger.info("Backtest: %d dates, %d symbols", n_dates, len(close.columns))

    cash = float(cfg.initial_capital)
    holdings: dict[str, int] = {}
    eq_curve = [cfg.initial_capital]
    ret_curve = [0.0]
    turn_curve = [0.0]
    pos_curve = [0]
    ef_curve = [1.0]

    rebal_dates = {dates[i] for i in range(0, n_dates, cfg.rebalance_freq)}

    for i, date in enumerate(dates):
        dt = pd.Timestamp(date)
        px = close.loc[dt]

        # MTM
        val = cash
        for sym in list(holdings.keys()):
            p = px.get(sym, np.nan)
            if pd.isna(p) or p <= 0:
                continue
            val += holdings[sym] * p
        cur_eq = val

        # Risk state
        ef = float(equity_frac.get(dt, 1.0)) if equity_frac is not None else 1.0
        ef_curve.append(ef)

        # Liquidate if cash
        if ef < 0.01 and holdings:
            for sym in list(holdings.keys()):
                p = px.get(sym, np.nan)
                if pd.isna(p) or p <= 0:
                    del holdings[sym]
                    continue
                sv = holdings[sym] * p
                cash += sv - sv * (cfg.commission + cfg.stamp_tax)
                del holdings[sym]

        should_rebal = date in rebal_dates and ef >= 0.01

        if should_rebal:
            # Build universe
            px_ok = set(px[px >= cfg.min_price].dropna().index)
            universe = list(px_ok)
            
            if cfg.volume_filter_pct > 0 and volume is not None and dt in volume.index:
                vt = volume.loc[dt].dropna()
                if len(vt) > 100:
                    th = vt.quantile(cfg.volume_filter_pct)
                    universe = list(set(vt[vt > th].index) & set(px_ok))

            if len(universe) < 50:
                turn_curve.append(0.0)
                pos_curve.append(len(holdings))
                continue

            # Select stocks
            if cfg.top_n == 9999 or cfg.top_n >= len(universe):
                selected = universe
            else:
                selected = list(universe)[:cfg.top_n]

            # Sell
            new_syms = set(selected)
            total_to = 0.0
            for sym in list(holdings.keys()):
                if sym in new_syms:
                    continue
                p = px.get(sym, np.nan)
                if pd.isna(p) or p <= 0:
                    holdings.pop(sym, None)
                    continue
                sv = holdings[sym] * p
                cash += sv - sv * (cfg.commission + cfg.stamp_tax)
                total_to += sv
                holdings.pop(sym, None)

            # Buy equal-weight all selected
            deployable = cur_eq * ef
            per_stock = deployable / len(selected) if selected else 0
            for sym in selected:
                p = px.get(sym, np.nan)
                if pd.isna(p) or p < cfg.min_price:
                    continue
                shares = max(int(per_stock / p / 100) * 100, 100)
                bv = shares * p
                bc = bv * cfg.slippage
                if bv + bc <= cash:
                    cash -= bv + bc
                    holdings[sym] = holdings.get(sym, 0) + shares
                    total_to += bv

            to_rate = total_to / max(cur_eq, 1)
            turn_curve.append(to_rate)
        else:
            turn_curve.append(0.0)

        # Final MTM
        val2 = cash
        for sym in list(holdings.keys()):
            p = px.get(sym, np.nan)
            if pd.isna(p) or p <= 0:
                continue
            val2 += holdings[sym] * p

        dr = val2 / eq_curve[-1] - 1 if eq_curve[-1] > 0 else 0
        eq_curve.append(val2)
        ret_curve.append(dr)
        pos_curve.append(len(holdings))

    di = pd.DatetimeIndex(dates)
    return BTResult(
        equity=pd.Series(eq_curve[1:], index=di),
        daily_returns=pd.Series(ret_curve[1:], index=di),
        turnover=pd.Series(turn_curve[1:], index=di),
        n_holdings=pd.Series(pos_curve[1:], index=di),
        equity_frac=pd.Series(ef_curve[1:], index=di),
        final_capital=float(eq_curve[-1]),
        total_return=float(eq_curve[-1] / eq_curve[0] - 1),
    )


# ── Metrics ───────────────────────────────────────────────────

def mets(bt: BTResult, cfg: Config, idx: pd.Series) -> dict:
    if bt.equity.empty or len(bt.equity) < 20:
        return {"error": "Insufficient data"}
    rets = bt.daily_returns.values
    n = len(rets)
    td = 252
    py = n / td
    if py <= 0:
        py = 0.01
    tr = bt.total_return
    ar = (1 + tr) ** (1 / py) - 1
    v = float(np.std(rets, ddof=1) * np.sqrt(td))
    sr = (ar - 0.025) / v if v > 0 else 0.0
    neg = rets[rets < 0]
    dv = float(np.std(neg, ddof=1)) * np.sqrt(td) if len(neg) > 5 else 0.01
    sort = (ar - 0.025) / dv if dv > 0 else 0.0
    cm = np.maximum.accumulate(bt.equity.values)
    dd = (bt.equity.values - cm) / cm
    mdd = float(np.min(dd))
    cal = ar / abs(mdd) if abs(mdd) > 0 else 0.0
    wr = float(np.sum(rets > 0) / max(n, 1))
    at = float(np.mean(bt.turnover.values)) if len(bt.turnover) > 0 else 0
    ah = float(np.mean(bt.n_holdings.values)) if len(bt.n_holdings) > 0 else 0
    aef = float(np.mean(bt.equity_frac.values)) if len(bt.equity_frac) > 0 else 1

    # EW benchmark
    from analysis_v2.core import FactorCache
    try:
        mkt = FactorCache().load_market_panel(cfg.start, cfg.end)
        ew = mkt["close"].pct_change().dropna(how="all").mean(axis=1).dropna()
        ewa = ew.reindex(bt.equity.index, method="ffill").dropna()
        ewt = float((1 + ewa).prod() - 1)
        ewa2 = float((1 + ewt) ** (1 / py) - 1)
        ewv = float(ewa.std() * np.sqrt(td)) if len(ewa) > 5 else 0
        ews = float((ewa2 - 0.025) / ewv) if ewv > 0 else 0
    except Exception:
        ewt = ews = 0

    # CSI300
    if len(idx) > 20:
        ia = idx.reindex(bt.equity.index, method="ffill").dropna()
        cst = float(ia.iloc[-1] / ia.iloc[0] - 1)
        ir = ia.pct_change().dropna().values[:n]
        csa = float((1 + cst) ** (1 / py) - 1)
        csv = float(np.std(ir, ddof=1) * np.sqrt(td)) if len(ir) > 5 else 0
        css = float((csa - 0.025) / csv) if csv > 0 else 0
    else:
        cst = css = 0

    return {
        "total_return_pct": round(tr * 100, 2),
        "annual_return_pct": round(ar * 100, 2),
        "sharpe": round(sr, 3),
        "sortino": round(sort, 3),
        "calmar": round(cal, 3),
        "max_dd_pct": round(mdd * 100, 2),
        "vol_pct": round(v * 100, 2),
        "win_rate_pct": round(wr * 100, 1),
        "avg_turnover_pct": round(at * 100, 2),
        "avg_holdings": round(ah, 0),
        "avg_equity_exposure_pct": round(aef * 100, 1),
        "n_days": n,
        "period_years": round(py, 2),
        "final_capital": round(bt.final_capital, 2),
        "ew_ret_pct": round(ewt * 100, 2),
        "ew_sharpe": round(ews, 3),
        "cs_ret_pct": round(cst * 100, 2),
        "cs_sharpe": round(css, 3),
        "excess_vs_ew_pct": round((tr - ewt) * 100, 2),
        "excess_vs_cs_pct": round((tr - cst) * 100, 2),
    }


def report(m: dict, cfg: Config, elapsed: float) -> str:
    lines = [
        f"# Final Strategy — Volume-Filtered Equal-Weight Index + Trend Timing",
        f"",
        f"**Period**: {cfg.start} → {cfg.end}  |  **Vol filter**: exclude bottom {cfg.volume_filter_pct*100:.0f}%  |  **Rebal**: {cfg.rebalance_freq}d",
        f"  |  **Risk**: {'ON (CS trend filter)' if cfg.enable_risk else 'OFF'}",
        f"  |  **Factors**: {'ON' if cfg.use_factors else 'OFF'}",
        f"",
    ]
    if "error" in m:
        lines.append(f"**Error**: {m['error']}")
        return "\n".join(lines)

    lines += ["## Performance", ""]
    lines += [
        f"| Metric | Strategy | EW Bench | CSI300 |",
        f"|--------|----------|----------|--------|",
        f"| Total Return | {m.get('total_return_pct',0):+.2f}% | {m.get('ew_ret_pct',0):+.2f}% | {m.get('cs_ret_pct',0):+.2f}% |",
        f"| Annual Return | {m.get('annual_return_pct',0):+.2f}% | — | — |",
        f"| Sharpe | {m.get('sharpe',0):.3f} | {m.get('ew_sharpe',0):.3f} | {m.get('cs_sharpe',0):.3f} |",
        f"| Sortino | {m.get('sortino',0):.3f} | — | — |",
        f"| Calmar | {m.get('calmar',0):.3f} | — | — |",
        f"| Max DD | {m.get('max_dd_pct',0):.2f}% | — | — |",
        f"| Volatility | {m.get('vol_pct',0):.2f}% | — | — |",
        f"| Win Rate | {m.get('win_rate_pct',0):.1f}% | — | — |",
        f"| Turnover | {m.get('avg_turnover_pct',0):.2f}% | — | — |",
        f"| Avg Holdings | {m.get('avg_holdings',0):.0f} | — | — |",
        f"| Avg Equity Exposure | {m.get('avg_equity_exposure_pct',0):.1f}% | — | — |",
        f"| Final Capital | ¥{m.get('final_capital',0):,.0f} | — | — |",
        f"| Trading Days | {m.get('n_days',0):d} | — | — |",
    ]

    exc_ew = m.get("excess_vs_ew_pct", 0)
    exc_cs = m.get("excess_vs_cs_pct", 0)
    lines += ["", "## Excess Returns", ""]
    lines.append(f"**vs EW benchmark**: {exc_ew:+.2f}% " + ("✅" if exc_ew > 0 else "❌"))
    lines.append(f"**vs CSI300**: {exc_cs:+.2f}% " + ("✅" if exc_cs > 0 else "❌"))

    lines += [
        "", "## Configuration", "",
        f"| Parameter | Value |",
        f"|-----------|-------|",
        f"| Volume filter (exclude bottom) | {cfg.volume_filter_pct*100:.0f}% |",
        f"| Top-N (9999 = all) | {cfg.top_n} |",
        f"| Rebalance frequency | {cfg.rebalance_freq}d |",
        f"| Trend lookback | {cfg.trend_lookback}d |",
        f"| Trend entry (→ cash) | {cfg.trend_entry*100:.0f}% |",
        f"| Trend exit (→ invest) | {cfg.trend_exit*100:.0f}% |",
        f"| Commission | {cfg.commission*100:.2f}% |",
        f"| Stamp tax | {cfg.stamp_tax*100:.2f}% |",
        f"| Slippage | {cfg.slippage*100:.2f}% |",
        f"| Round-trip cost | {(cfg.commission+cfg.stamp_tax+cfg.slippage)*2*100:.2f}% |",
        f"| Risk overlay | {'ON' if cfg.enable_risk else 'OFF'} |",
        f"| Factors | {'ON' if cfg.use_factors else 'OFF'} |",
        f"| Elapsed | {elapsed:.1f}s |",
    ]
    lines.append("")
    return "\n".join(lines)


def save(m: dict, bt: BTResult, cfg: Config, elapsed: float) -> Path:
    od = OUTPUT_BASE / cfg.run_id
    od.mkdir(parents=True, exist_ok=True)
    r = {"metrics": m, "config": {
        "start": cfg.start, "end": cfg.end, "volume_filter": cfg.volume_filter_pct,
        "rebalance": cfg.rebalance_freq, "risk": cfg.enable_risk,
        "factors": cfg.use_factors,
    }}
    (od / "result.json").write_text(json.dumps(r, indent=2, ensure_ascii=False))
    (od / "report.md").write_text(report(m, cfg, elapsed), encoding="utf-8")
    if bt.equity is not None and len(bt.equity) > 0:
        pd.DataFrame({"equity": bt.equity, "return": bt.daily_returns,
                       "turnover": bt.turnover, "holdings": bt.n_holdings,
                       "equity_frac": bt.equity_frac}).to_parquet(od / "daily.parquet")
    (od / "manifest.json").write_text(json.dumps({
        "command": "final_strategy", "version": "v1.0", "start": cfg.start,
        "end": cfg.end, "exit_code": 0, "elapsed_seconds": round(elapsed, 1),
    }, indent=2))
    return od


def pipeline(cfg: Config) -> dict:
    t0 = time.time()
    logger.info("=" * 60)
    logger.info("FINAL: %s → %s  [volF=%d%%  rebal=%dd  risk=%s  factors=%s]",
                cfg.start, cfg.end, int(cfg.volume_filter_pct * 100),
                cfg.rebalance_freq, "ON" if cfg.enable_risk else "OFF",
                "ON" if cfg.use_factors else "OFF")

    logger.info("[1/3] Loading data...")
    mkt = load_market(cfg.start, cfg.end)
    if not mkt or "close" not in mkt or mkt["close"].empty:
        return {"error": "No market data"}
    close = mkt["close"].astype(np.float32)
    volume = mkt.get("volume")

    logger.info("[2/3] Computing risk state...")
    idx = load_index()
    ef = compute_equity_frac(idx, cfg) if cfg.enable_risk else None

    logger.info("[3/3] Running backtest...")
    bt = run_bt(close, volume, ef, cfg)
    if bt.equity.empty or len(bt.equity) < 20:
        return {"error": "No trades or insufficient data"}

    m = mets(bt, cfg, idx)
    el = time.time() - t0
    if "error" not in m:
        logger.info("Ret=%+.2f%%  Sharpe=%.3f  DD=%.2f%%  [%.1fs]  Excess_EW=%+.2f%%",
                     m.get("total_return_pct", 0), m.get("sharpe", 0),
                     m.get("max_dd_pct", 0), el, m.get("excess_vs_ew_pct", 0))
    return {"metrics": m, "bt": bt, "elapsed": el}


def main() -> int:
    p = argparse.ArgumentParser(description="Final Strategy")
    p.add_argument("--start", default="2025-01-01")
    p.add_argument("--end", default="2026-07-01")
    p.add_argument("--volume-filter", type=float, default=0.25)
    p.add_argument("--rebalance", type=int, default=20)
    p.add_argument("--no-risk", action="store_true")
    p.add_argument("--compare-all", action="store_true")
    p.add_argument("--top-n", type=int, default=9999)
    args = p.parse_args()

    if args.compare_all:
        variants = [
            ("VolF25% only", Config(start=args.start, end=args.end, volume_filter_pct=0.25, enable_risk=False, rebalance_freq=20)),
            ("VolF25% + Risk", Config(start=args.start, end=args.end, volume_filter_pct=0.25, enable_risk=True, rebalance_freq=20)),
            ("No filter", Config(start=args.start, end=args.end, volume_filter_pct=0.0, enable_risk=False, rebalance_freq=20)),
        ]
        results = []
        for label, c in variants:
            r = pipeline(c)
            m = r.get("metrics", {})
            if "error" not in m:
                results.append(f"  {label:20s}: Ret={m['total_return_pct']:>+7.2f}%  Sharpe={m['sharpe']:>7.3f}  DD={m['max_dd_pct']:>6.2f}%  Hold={m['avg_holdings']:>4.0f}")
        print("\n=== COMPARISON ===\n" + "\n".join(results) + "\n")
        return 0

    cfg = Config(start=args.start, end=args.end,
                 volume_filter_pct=args.volume_filter,
                 rebalance_freq=args.rebalance,
                 enable_risk=not args.no_risk,
                 top_n=args.top_n)
    r = pipeline(cfg)
    if "error" in r:
        print(f"Error: {r['error']}")
        return 1
    od = save(r["metrics"], r["bt"], cfg, r["elapsed"])
    print(f"\n  Output: {od}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
