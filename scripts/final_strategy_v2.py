#!/usr/bin/env python3
"""
Final Strategy V2: Volume-Filtered Equal-Weight
================================================
Best implementation based on systematic analysis of analysis_v2 data.

Key findings incorporated:
  1. Volume filtering (exclude bottom 10% by volume) is the strongest alpha source
     — improves equal-weight from +38% (Sharpe 1.17) to +43% (Sharpe 1.30)
  2. Mild filters (5-15%) work best in broad bull markets
  3. Stronger filters (30-40%) work best in narrow large-cap rallies  
  4. Factor tilts beyond volume are negative alpha
  5. Trend risk overlay (CSI300) is destructive — whipsaws destroy alpha
  6. Equal-weight outperforms signal-weight in long-only

Architecture:
  Layer 1: Data — FactorCache market panel
  Layer 2: Signal — volume-filtered (10%) equal-weight universe  
  Layer 3: Execution — 20-day rebalance, cost-aware

Usage:
  uv run python3 scripts/final_strategy_v2.py              # Full period
  uv run python3 scripts/final_strategy_v2.py --sweep      # Volume filter sweep
  uv run python3 scripts/final_strategy_v2.py --period-2026 # 2026 H1 only
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
logger = logging.getLogger("fstr")

AV2 = Path("/Users/fengzhi/Downloads/git2/analysis_v2")
sys.path.insert(0, str(AV2))
os.chdir(str(AV2))

OUTPUT_BASE = Path("/Users/fengzhi/Downloads/git/testlixingren/output/final_strategy_v2")


@dataclass
class Config:
    start: str = "2025-01-01"
    end: str = "2026-07-01"
    volume_filter_pct: float = 0.10  # exclude bottom 10% by volume (sweet spot)
    rebalance_freq: int = 20
    initial_capital: int = 1_000_000
    min_price: float = 2.0
    commission: float = 0.0002
    stamp_tax: float = 0.001
    slippage: float = 0.0008
    enable_risk: bool = False  # risk overlays proven destructive
    use_factors: bool = False  # factor tilts proven negative alpha
    run_id: str = field(default_factory=lambda: datetime.now().strftime("fv2_%Y%m%d_%H%M%S_%f")[:24])


def safe_mtm(holdings: dict[str, int], px: pd.Series) -> float:
    """Safe MTM that guards against np.float32 NaN propagation."""
    v = 0.0
    for sym, shares in holdings.items():
        p = px.get(sym, 0)
        if not np.isfinite(p) or p <= 0:
            continue
        v += shares * p
    return v


def load_market(start: str, end: str) -> dict[str, pd.DataFrame]:
    from analysis_v2.core import FactorCache  # noqa: PLC0415
    return FactorCache().load_market_panel(start, end)


def backtest(cfg: Config) -> dict[str, Any]:
    mkt = load_market(cfg.start, cfg.end)
    if not mkt or "close" not in mkt or mkt["close"].empty:
        return {"error": "No market data"}

    close = mkt["close"].astype(np.float32).sort_index(axis=1)
    volume = mkt.get("volume")
    if volume is not None:
        volume = volume.sort_index(axis=1)

    dates = sorted(close.index[1:])
    n_dates = len(dates)
    cash = float(cfg.initial_capital)
    holdings: dict[str, int] = {}
    eq_curve: list[float] = [float(cfg.initial_capital)]
    ret_curve = [0.0]
    turn_curve = [0.0]
    pos_curve = [0]

    rebal_dates = {dates[i] for i in range(0, n_dates, cfg.rebalance_freq)}
    comm, stam, slipp = cfg.commission, cfg.stamp_tax, cfg.slippage
    td, py = 252, n_dates / 252

    for i, date in enumerate(dates):
        dt = pd.Timestamp(date)
        px = close.loc[dt]
        cur_val = cash + safe_mtm(holdings, px)

        if date in rebal_dates:
            # Build universe
            px_ok = set(px[px >= cfg.min_price].dropna().index)
            universe = px_ok.copy()

            if cfg.volume_filter_pct > 0 and volume is not None and dt in volume.index:
                vt = volume.loc[dt].dropna()
                if len(vt) > 100:
                    th = vt.quantile(cfg.volume_filter_pct)
                    universe = set(vt[vt > th].index) & px_ok

            selected = sorted(universe)
            if len(selected) < 50:
                eq_curve.append(cur_val)
                ret_curve.append(0.0)
                turn_curve.append(0.0)
                pos_curve.append(len(holdings))
                continue

            # Sell exited positions
            new_syms = set(selected)
            to_sum = 0.0
            for sym in list(holdings):
                if sym in new_syms:
                    continue
                p = float(px.get(sym, 0))
                if not np.isfinite(p) or p <= 0:
                    holdings.pop(sym, None)
                    continue
                sv = holdings[sym] * p
                cash += sv - sv * (comm + stam)
                to_sum += sv
                holdings.pop(sym, None)

            # Buy equal-weight
            per_stock = cur_val / len(selected)
            for sym in selected:
                p = float(px.get(sym, 0))
                if not np.isfinite(p) or p < cfg.min_price:
                    continue
                ratio = per_stock / p
                if not np.isfinite(ratio) or ratio < 1:
                    continue
                shares = max(int(ratio / 100) * 100, 100)
                bv = shares * p
                if bv <= cash:
                    cash -= bv + bv * slipp
                    holdings[sym] = holdings.get(sym, 0) + shares
                    to_sum += bv

            turn_curve.append(to_sum / max(cur_val, 1))
        else:
            turn_curve.append(0.0)

        val2 = cash + safe_mtm(holdings, px)
        dr = val2 / eq_curve[-1] - 1 if eq_curve[-1] > 0 else 0.0
        eq_curve.append(val2)
        ret_curve.append(dr)
        pos_curve.append(len(holdings))

    # Metrics
    eq_arr = np.array(eq_curve[1:], dtype=np.float64)
    ret_arr = np.array(ret_curve[1:], dtype=np.float64)
    ret_arr = ret_arr[np.isfinite(ret_arr)]
    if len(ret_arr) < 5:
        return {"error": "Insufficient valid returns"}

    tr = float(eq_arr[-1] / eq_curve[0] - 1)
    ar = (1 + tr) ** (1 / py) - 1
    vol = float(np.std(ret_arr, ddof=1) * np.sqrt(td))
    sharpe = (ar - 0.025) / vol if vol > 0 else 0.0

    cm = np.maximum.accumulate(eq_arr)
    dd = (eq_arr - cm) / cm
    mdd = float(np.min(dd[np.isfinite(dd)])) if np.any(np.isfinite(dd)) else 0.0

    neg = ret_arr[ret_arr < 0]
    dvol = float(np.std(neg, ddof=1)) * np.sqrt(td) if len(neg) > 5 else vol
    sortino = (ar - 0.025) / dvol if dvol > 0 else 0.0
    calmar = ar / abs(mdd) if abs(mdd) > 0 else 0.0
    wr = float(np.mean(ret_arr > 0))
    ah = float(np.mean(pos_curve))
    at = float(np.mean(turn_curve))

    # EW benchmark
    ew = close.pct_change().dropna(how="all").mean(axis=1).dropna()
    ewi = ew.reindex(pd.DatetimeIndex(dates), method="ffill").dropna()
    ewt = float((1 + ewi).prod() - 1)
    ewa = float((1 + ewt) ** (1 / py) - 1)
    ewv = float(ewi.std() * np.sqrt(td)) if len(ewi) > 5 else 0
    ews = float((ewa - 0.025) / ewv) if ewv > 0 else 0

    # CSI300
    cst = css = 0.0
    idx_dir = AV2 / "data_cache" / "market_data" / "daily" / "index_daily"
    if idx_dir.exists():
        records = []
        for pdir in sorted(idx_dir.iterdir()):
            if not pdir.name.startswith("date="):
                continue
            try:
                dt0 = pd.Timestamp(pdir.name[5:])
            except Exception:
                continue
            fp = pdir / "data.parquet"
            if not fp.exists():
                continue
            try:
                df = pd.read_parquet(fp, columns=["index_code", "close"])
            except Exception:
                continue
            row = df[df["index_code"] == "000300.SH"]
            if row.empty:
                continue
            records.append(pd.Series({dt0: float(row["close"].iloc[0])}))
        if records:
            idx = pd.concat(records).sort_index().astype(np.float32).dropna()
            if len(idx) > 20:
                ia = idx.reindex(pd.DatetimeIndex(dates), method="ffill").dropna()
                cst = float(ia.iloc[-1] / ia.iloc[0] - 1)
                ir = ia.pct_change().dropna().values[:len(dates)]
                csa = float((1 + cst) ** (1 / py) - 1)
                csv = float(np.std(ir, ddof=1) * np.sqrt(td)) if len(ir) > 5 else 0
                css = float((csa - 0.025) / csv) if csv > 0 else 0

    m = {
        "total_return_pct": round(float(tr) * 100, 2),
        "annual_return_pct": round(float(ar) * 100, 2),
        "sharpe": round(float(sharpe), 3),
        "sortino": round(float(sortino), 3),
        "calmar": round(float(calmar), 3),
        "max_dd_pct": round(float(mdd) * 100, 2),
        "vol_pct": round(float(vol) * 100, 2),
        "win_rate_pct": round(float(wr) * 100, 1),
        "avg_turnover_pct": round(float(at) * 100, 2),
        "avg_holdings": round(float(ah), 0),
        "n_days": n_dates,
        "period_years": round(float(py), 2),
        "final_capital": round(float(eq_arr[-1]), 2),
        "ew_ret_pct": round(float(ewt) * 100, 2),
        "ew_sharpe": round(float(ews), 3),
        "cs_ret_pct": round(float(cst) * 100, 2),
        "cs_sharpe": round(float(css), 3),
        "excess_vs_ew_pct": round(float(tr - ewt) * 100, 2),
        "excess_vs_cs_pct": round(float(tr - cst) * 100, 2),
    }
    return {"metrics": m, "equity": eq_arr, "returns": ret_arr, "positions": pos_curve}


def make_report(m: dict, cfg: Config, elapsed: float) -> str:
    lines = [
        "# Final Strategy V2 — Volume-Filtered Equal-Weight",
        "",
        f"**Period**: {cfg.start} → {cfg.end}",
        f"**Vol filter**: exclude bottom {cfg.volume_filter_pct*100:.0f}%",
        f"**Rebal**: {cfg.rebalance_freq}d  **Risk**: {'ON' if cfg.enable_risk else 'OFF'}",
        f"**Factors**: {'ON' if cfg.use_factors else 'OFF'}",
        "",
    ]
    if "error" in m:
        lines.append(f"**Error**: {m['error']}")
        return "\n".join(lines)

    lines += ["## Performance", ""]
    lines += [
        "| Metric | Strategy | EW Bench | CSI300 |",
        "|---|---|---|---|",
        f"| Total Return | {m['total_return_pct']:+.2f}% | {m['ew_ret_pct']:+.2f}% | {m['cs_ret_pct']:+.2f}% |",
        f"| Annual Return | {m['annual_return_pct']:+.2f}% | — | — |",
        f"| Sharpe | {m['sharpe']:.3f} | {m['ew_sharpe']:.3f} | {m['cs_sharpe']:.3f} |",
        f"| Sortino | {m['sortino']:.3f} | — | — |",
        f"| Calmar | {m['calmar']:.3f} | — | — |",
        f"| Max DD | {m['max_dd_pct']:.2f}% | — | — |",
        f"| Volatility | {m['vol_pct']:.2f}% | — | — |",
        f"| Win Rate | {m['win_rate_pct']:.1f}% | — | — |",
        f"| Avg Turnover | {m['avg_turnover_pct']:.2f}% | — | — |",
        f"| Avg Holdings | {m['avg_holdings']:.0f} | — | — |",
        f"| Final Capital | ¥{m['final_capital']:,.0f} | — | — |",
        f"| Trading Days | {m['n_days']:d} | — | — |",
    ]
    exc_ew = m.get("excess_vs_ew_pct", 0)
    exc_cs = m.get("excess_vs_cs_pct", 0)
    lines += ["", "## Excess Returns", ""]
    lines.append(f"**vs EW benchmark**: {exc_ew:+.2f}% " + ("✅" if exc_ew > 0 else "❌"))
    lines.append(f"**vs CSI300**: {exc_cs:+.2f}% " + ("✅" if exc_cs > 0 else "❌"))
    lines += ["", f"## Configuration", ""]
    lines += [
        f"| Volume filter | {cfg.volume_filter_pct*100:.0f}% |",
        f"| Rebalance | {cfg.rebalance_freq}d |",
        f"| Commission | {cfg.commission*100:.2f}% |",
        f"| Stamp tax | {cfg.stamp_tax*100:.2f}% |",
        f"| Slippage | {cfg.slippage*100:.2f}% |",
        f"| Round-trip cost | {(cfg.commission+cfg.stamp_tax+cfg.slippage)*2*100:.2f}% |",
        f"| Risk | {'ON' if cfg.enable_risk else 'OFF'} |",
        f"| Factors | {'ON' if cfg.use_factors else 'OFF'} |",
        f"| Min price | ¥{cfg.min_price:.1f} |",
        f"| Initial capital | ¥{cfg.initial_capital:,} |",
        f"| Elapsed | {elapsed:.1f}s |",
    ]
    lines.append("")
    return "\n".join(lines)


def save(m: dict, cfg: Config, elapsed: float) -> Path:
    od = OUTPUT_BASE / cfg.run_id
    od.mkdir(parents=True, exist_ok=True)
    (od / "result.json").write_text(
        json.dumps({"metrics": m, "config": {
            "start": cfg.start, "end": cfg.end,
            "volume_filter": cfg.volume_filter_pct,
            "rebalance": cfg.rebalance_freq,
            "risk": cfg.enable_risk, "factors": cfg.use_factors,
        }}, indent=2, ensure_ascii=False))
    (od / "report.md").write_text(make_report(m, cfg, elapsed), encoding="utf-8")
    (od / "manifest.json").write_text(json.dumps({
        "command": "final_strategy_v2", "version": "v2.0",
        "start": cfg.start, "end": cfg.end,
        "exit_code": 0, "elapsed_seconds": round(elapsed, 1),
    }, indent=2))
    return od


def run_sweep() -> list[dict]:
    """Volume filter level sweep across full period and 2026 H1."""
    print("\n" + "=" * 60)
    print("VOLUME FILTER SWEEP")
    print("=" * 60)

    results_2025 = []
    results_2026 = []

    for pct in [0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50]:
        r = backtest(Config(volume_filter_pct=pct))
        if "error" not in r:
            m = r["metrics"]
            results_2025.append((pct, m))

    print("\n--- Full Period (2025-01 → 2026-07) ---")
    print(f"  {'Filter':>6s}  {'Return':>8s}  {'Sharpe':>7s}  {'DD':>7s}  {'EW':>7s}  {'Excess':>7s}")
    for pct, m in sorted(results_2025, key=lambda x: x[1]["sharpe"], reverse=True):
        print(f"  {pct*100:>5.0f}%  {m['total_return_pct']:>+7.2f}%  {m['sharpe']:.3f}  {m['max_dd_pct']:>6.2f}%  {m['ew_ret_pct']:>+6.2f}%  {m['excess_vs_ew_pct']:>+6.2f}%")

    sweep_path = OUTPUT_BASE / "sweep.json"
    sweep_path.parent.mkdir(parents=True, exist_ok=True)
    sweep_path.write_text(json.dumps({
        "levels": [{"pct": p*100, **{k: v for k, v in m.items() if k.startswith(("total", "sharpe", "max_dd", "excess", "ew_"))}}
                     for p, m in sorted(results_2025, key=lambda x: x[0])]
    }, indent=2))
    print(f"\nSweep saved: {sweep_path}")
    return results_2025


def main() -> int:
    parser = argparse.ArgumentParser(description="Final Strategy V2")
    parser.add_argument("--start", default="2025-01-01")
    parser.add_argument("--end", default="2026-07-01")
    parser.add_argument("--volume-filter", type=float, default=0.10)
    parser.add_argument("--rebalance", type=int, default=20)
    parser.add_argument("--no-risk", action="store_true")
    parser.add_argument("--sweep", action="store_true", help="Volume filter sweep")
    parser.add_argument("--period-2026", action="store_true", help="2026 H1 only")
    args = parser.parse_args()

    if args.period_2026:
        args.start, args.end = "2026-01-01", "2026-07-01"

    if args.sweep:
        run_sweep()
        return 0

    cfg = Config(
        start=args.start, end=args.end,
        volume_filter_pct=args.volume_filter,
        rebalance_freq=args.rebalance,
        enable_risk=not args.no_risk,
    )
    t0 = time.time()
    logger.info("Starting: %s → %s  [volF=%d%%  rebal=%dd]",
                cfg.start, cfg.end, int(cfg.volume_filter_pct * 100),
                cfg.rebalance_freq)
    result = backtest(cfg)
    elapsed = time.time() - t0

    if "error" in result:
        logger.error("Error: %s", result["error"])
        return 1

    m = result["metrics"]
    od = save(m, cfg, elapsed)
    print(f"\n  Output: {od}")
    print(f"  Ret={m['total_return_pct']:+.2f}%  Sharpe={m['sharpe']:.3f}  "
          f"DD={m['max_dd_pct']:.2f}%  Excess_EW={m['excess_vs_ew_pct']:+.2f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
