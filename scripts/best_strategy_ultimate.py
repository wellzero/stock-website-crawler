#!/usr/bin/env python3
"""
Best Strategy Ultimate — Regime-Conditional Factor Composite
============================================================

Empirically-derived factor strategy using analysis_v2's full A-share factor parquet.

ARCHITECTURE
  1. 13 factor panels loaded from parquet (5500+ stocks per factor)
  2. Regime: CSI300 vol + A-stock breadth → RISK_ON/NORMAL/CAUTIOUS/DEFENSIVE
  3. Regime-conditional factor weights (different emphasis per regime)
  4. Composite signal: rank-norm × regime-weights
  5. Backtest: T+1, signal-weighted, costs
  6. Report: JSON + Markdown

FACTOR UNIVERSE (13 full-universe):
  Value:     pb_ratio
  Quality:   yoy_eps, ocfp, yoy_roe, gross_margin, dim_quality
  Flow:      cmf_20, wvad, flow_net_mom_20
  Liquidity: liquidity_amihud
  Risk:      max_drawdown_20, volatility_20
  Quality:   defense_accrual_proxy

REGIME WEIGHTS:
  RISK_ON:   flow/momentum heavy, 0% cash
  NORMAL:    balanced, 0% cash
  CAUTIOUS:  quality/value heavy, 30% cash
  DEFENSIVE: quality/low-risk only, 70% cash

AUTHOR: Auto-generated, 2026-07-04
"""
from __future__ import annotations

import argparse, json, logging, os, sys, time, warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=RuntimeWarning)
warnings.filterwarnings("ignore", category=UserWarning)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────
AV2 = Path("/Users/fengzhi/Downloads/git2/analysis_v2")
assert AV2.exists(), f"analysis_v2 not found: {AV2}"
DATA_CACHE = AV2 / "data_cache"
FACTORS_DIR = DATA_CACHE / "factors"
MKT_DIR = DATA_CACHE / "market_data" / "daily" / "stock_daily"
IDX_DIR = DATA_CACHE / "market_data" / "daily" / "index_daily"
OUTPUT_BASE = Path.cwd() / "output" / "best_ultimate"

# ── Factor definitions ────────────────────────────────────────
# (name, parquet_file, direction, family)
# All factors are from full-universe files (5500+ stocks)
FACTOR_DEFS: list[tuple[str, str, str, str]] = [
    ("pb_ratio",             "factors_financial.parquet",     "neg", "Value"),
    ("yoy_eps",              "factors_financial.parquet",     "pos", "Quality"),
    ("ocfp",                 "factors_financial.parquet",     "pos", "Quality"),
    ("yoy_roe",              "factors_financial.parquet",     "pos", "Quality"),
    ("gross_margin",         "factors_financial.parquet",     "pos", "Quality"),
    ("cmf_20",               "factors_volume.parquet",        "pos", "Flow"),
    ("wvad",                 "factors_volume.parquet",        "pos", "Flow"),
    ("dim_quality",          "factors_strategy_a.parquet",    "pos", "Quality"),
    ("liquidity_amihud",     "factors_strategy_a.parquet",    "neg", "Liquidity"),
    ("flow_net_mom_20",      "factors_strategy_a.parquet",    "pos", "Flow"),
    ("defense_accrual_proxy","factors_strategy_a.parquet",    "neg", "Quality"),
    ("max_drawdown_20",      "factors_risk_factors.parquet",  "neg", "Risk"),
    ("volatility_20",        "factors_risk_factors.parquet",  "neg", "Risk"),
]

FACTOR_NAMES = [d[0] for d in FACTOR_DEFS]
FACTOR_MAP = {d[0]: (d[1], d[2], d[3]) for d in FACTOR_DEFS}
N_FACTORS = len(FACTOR_DEFS)

# Regime-conditional factor weights (sum to 1.0 per regime)
REGIME_WEIGHTS: dict[str, dict[str, float]] = {
    "RISK_ON": {
        "flow_net_mom_20": 0.18, "cmf_20": 0.14, "wvad": 0.12,
        "dim_quality": 0.10, "yoy_eps": 0.10, "pb_ratio": 0.08,
        "ocfp": 0.06, "yoy_roe": 0.06, "gross_margin": 0.05,
        "liquidity_amihud": 0.04, "defense_accrual_proxy": 0.04,
        "max_drawdown_20": 0.02, "volatility_20": 0.01,
    },
    "NORMAL": {n: 1.0/N_FACTORS for n in FACTOR_NAMES},
    "CAUTIOUS": {
        "dim_quality": 0.16, "yoy_eps": 0.14, "pb_ratio": 0.12,
        "ocfp": 0.10, "gross_margin": 0.10, "yoy_roe": 0.08,
        "max_drawdown_20": 0.08, "volatility_20": 0.06,
        "defense_accrual_proxy": 0.06, "cmf_20": 0.04,
        "wvad": 0.03, "flow_net_mom_20": 0.02, "liquidity_amihud": 0.01,
    },
    "DEFENSIVE": {
        "dim_quality": 0.25, "max_drawdown_20": 0.18, "yoy_eps": 0.14,
        "ocfp": 0.12, "pb_ratio": 0.10, "gross_margin": 0.08,
        "yoy_roe": 0.06, "volatility_20": 0.04, "defense_accrual_proxy": 0.03,
    },
}

REGIME_CASH: dict[str, float] = {
    "RISK_ON": 0.00, "NORMAL": 0.00, "CAUTIOUS": 0.30, "DEFENSIVE": 0.70, "EMPTY": 1.00,
}

@dataclass
class Config:
    start: str = "2026-01-05"
    end: str = "2026-07-01"
    top_n: int = 30
    rebalance_freq: int = 10
    initial_capital: float = 1_000_000.0
    min_price: float = 2.0
    commission: float = 0.0003
    stamp_tax: float = 0.001
    slippage: float = 0.001
    index_code: str = "000300.SH"
    walk_forward_folds: int = 0

# ═════════════════════════════════════════════════════════════════
# 1. Data Loading
# ═════════════════════════════════════════════════════════════════

def _group_by_source() -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for name, fname, _, _ in FACTOR_DEFS:
        groups.setdefault(fname, []).append(name)
    return groups

def load_factors_panel(start: str, end: str) -> dict[str, pd.DataFrame]:
    """Scan factor date dirs and load requested factor columns into date×symbol panels."""
    s_dt = pd.Timestamp(start) - pd.Timedelta(days=30)
    e_dt = pd.Timestamp(end) + pd.Timedelta(days=5)
    groups = _group_by_source()
    collectors: dict[str, dict] = {n: {} for n in FACTOR_NAMES}

    n_scanned = 0
    for year_dir in sorted(FACTORS_DIR.iterdir()):
        if not year_dir.is_dir() or not year_dir.name.isdigit():
            continue
        for date_dir in sorted(year_dir.iterdir()):
            if not date_dir.is_dir():
                continue
            try:
                dt = pd.Timestamp(date_dir.name)
            except Exception:
                continue
            if dt < s_dt or dt > e_dt:
                continue
            n_scanned += 1
            for fname, wanted in groups.items():
                fp = date_dir / fname
                if not fp.exists():
                    continue
                cols_to_read = ["symbol"] + [c for c in wanted if c in collectors]
                if len(cols_to_read) < 2:
                    continue
                try:
                    df = pd.read_parquet(fp, columns=cols_to_read)
                except Exception:
                    continue
                for col in wanted:
                    if col not in df.columns:
                        continue
                    ser = df[["symbol", col]].dropna().set_index("symbol")[col]
                    if ser.empty:
                        continue
                    if ser.index.duplicated().any():
                        ser = ser[~ser.index.duplicated(keep="first")]
                    collectors[col][str(dt.date())] = ser

    result: dict[str, pd.DataFrame] = {}
    for name in FACTOR_NAMES:
        data = collectors.get(name, {})
        if not data:
            continue
        try:
            panel = pd.DataFrame(data).T.sort_index().astype(np.float32)
            panel = panel.replace([np.inf, -np.inf], np.nan)
            result[name] = panel
        except Exception:
            continue

    logger.info("Loaded %d/%d factors from %d date dirs", len(result), N_FACTORS, n_scanned)
    return result

def load_market_panel(start: str, end: str) -> dict[str, pd.DataFrame]:
    """Load OHLCV from stock_daily parquet."""
    s_dt, e_dt = pd.Timestamp(start), pd.Timestamp(end)
    records: list[pd.DataFrame] = []
    for pdir in sorted(MKT_DIR.iterdir()):
        name = pdir.name
        if not name.startswith("date="):
            continue
        try:
            dt = pd.Timestamp(name[5:])
        except Exception:
            continue
        if dt < s_dt or dt > e_dt:
            continue
        for fp in pdir.glob("*.parquet"):
            try:
                df = pd.read_parquet(fp, columns=["symbol", "close", "volume", "amount"])
            except Exception:
                continue
            df["date"] = dt
            records.append(df)
            break
    if not records:
        logger.error("No market data for %s–%s", start, end)
        return {}

    pdf = pd.concat(records, ignore_index=True)
    pdf["symbol"] = pdf["symbol"].str.lower()
    pdf = pdf.drop_duplicates(subset=["date", "symbol"])
    panels: dict[str, pd.DataFrame] = {}
    for col in ["close", "volume", "amount"]:
        panels[col] = pdf.pivot(index="date", columns="symbol", values=col).sort_index().astype(np.float32)
    panels["ret"] = panels["close"].pct_change().fillna(0).clip(-0.2, 0.2).astype(np.float32)
    logger.info("Market: %d dates × %d symbols", len(panels["close"]), panels["close"].shape[1])
    return panels

def load_index(idx_code: str = "000300.SH") -> pd.Series:
    """Load index close prices."""
    records: list[dict] = []
    for pdir in sorted(IDX_DIR.iterdir()):
        if not pdir.name.startswith("date="):
            continue
        try:
            dt = pd.Timestamp(pdir.name[5:])
        except Exception:
            continue
        for fp in pdir.glob("*.parquet"):
            try:
                df = pd.read_parquet(fp, columns=["index_code", "close"])
            except Exception:
                continue
            mask = df["index_code"].str.contains(idx_code[:6], case=False, na=False)
            if not mask.any():
                continue
            records.append({"date": dt, "close": float(df.loc[mask, "close"].iloc[0])})
            break
    if not records:
        logger.warning("No index data for %s", idx_code)
        return pd.Series(dtype=float)
    s = pd.DataFrame(records).sort_values("date").set_index("date")["close"].astype(np.float32).dropna()
    logger.info("Index %s: %d days", idx_code, len(s))
    return s

# ═════════════════════════════════════════════════════════════════
# 2. Regime Detection
# ═════════════════════════════════════════════════════════════════

def detect_regime(idx_close: pd.Series, mkt_close: pd.DataFrame | None = None) -> pd.Series:
    """Detect regime from CSI300 vol + A-stock breadth."""
    ret = idx_close.pct_change().dropna()
    vol = (ret.rolling(40, min_periods=10).std() * np.sqrt(252)).dropna()
    if len(vol) < 10:
        return pd.Series("NORMAL", index=pd.DatetimeIndex([pd.Timestamp.today()]))

    lv, hv = float(vol.quantile(0.33)), float(vol.quantile(0.67))
    vol_r = vol.apply(lambda v: "QUIET" if v <= lv else ("HIGH_VOL" if v >= hv else "NORMAL"))

    if mkt_close is not None and not mkt_close.empty:
        ret_m = mkt_close.pct_change()
        up = (ret_m > 0).sum(axis=1)
        tot = ret_m.notna().sum(axis=1).replace(0, np.nan)
        brd = (up / tot).dropna()
        b_sma = brd.rolling(20, min_periods=5).mean().dropna()
        brd_r = b_sma.apply(lambda b: "RISK_ON" if b >= 0.60 else ("DEFENSIVE" if b <= 0.40 else "CAUTIOUS"))
    else:
        brd_r = pd.Series("CAUTIOUS", index=vol_r.index)

    both = pd.DataFrame({"vol": vol_r, "brd": brd_r}).dropna()
    def _combo(r):
        if r["vol"] == "HIGH_VOL" and r["brd"] == "DEFENSIVE":
            return "EMPTY"
        if r["vol"] == "HIGH_VOL":
            return "DEFENSIVE"
        if r["brd"] == "RISK_ON":
            return "RISK_ON"
        if r["brd"] == "DEFENSIVE":
            return "DEFENSIVE"
        return r["brd"] if r["brd"] in ("CAUTIOUS",) else "NORMAL"
    reg = both.apply(_combo, axis=1)
    logger.info("Regime dist: %s", dict(reg.value_counts()))
    return reg

# ═════════════════════════════════════════════════════════════════
# 3. Signal Construction
# ═════════════════════════════════════════════════════════════════

def rank_norm(panel: pd.DataFrame, direction: str = "pos") -> pd.DataFrame:
    """Cross-sectional rank normalization to [-1, 1]."""
    r = panel.rank(axis=1, pct=True, na_option="keep")
    s = (r - 0.5) * 2
    return s * (1 if direction == "pos" else -1)

def build_composite_signal(
    factor_panels: dict[str, pd.DataFrame],
    regimes: pd.Series,
    regime_weights: dict[str, dict[str, float]],
) -> pd.DataFrame:
    """Build regime-conditional composite signal."""
    normed: dict[str, pd.DataFrame] = {}
    for name, panel in factor_panels.items():
        _, direction, _ = FACTOR_MAP.get(name, (None, "pos", None))
        if direction is None:
            continue
        normed[name] = rank_norm(panel, direction)

    if not normed:
        return pd.DataFrame(dtype=float)

    all_dates = sorted({d for p in normed.values() for d in p.index})
    common_symbols = sorted(set.intersection(*[set(p.columns) for p in normed.values()]) if normed else set())

    composites: list[pd.Series] = []
    for dt in all_dates:
        weights = regime_weights.get(str(regimes.get(pd.Timestamp(dt), "NORMAL")), regime_weights["NORMAL"])
        weighted: list[pd.DataFrame] = []
        for name, w in weights.items():
            if name not in normed:
                continue
            if dt not in normed[name].index:
                continue
            row = normed[name].loc[dt].dropna()
            if row.empty:
                continue
            weighted.append(row * w)
        if len(weighted) < max(3, N_FACTORS // 3):
            # Fallback: equal weight available factors
            alt: list[pd.DataFrame] = []
            for name in normed:
                if dt in normed[name].index:
                    row = normed[name].loc[dt].dropna()
                    if not row.empty:
                        alt.append(row)
            if len(alt) < 3:
                continue
            composite = sum(alt) / len(alt)
        else:
            composite = sum(weighted)
        composite.name = dt
        composites.append(composite)

    if not composites:
        return pd.DataFrame(dtype=float)
    return pd.DataFrame(composites).sort_index()

# ═════════════════════════════════════════════════════════════════
# 4. Backtest Engine
# ═════════════════════════════════════════════════════════════════

@dataclass
class BacktestResult:
    equity: pd.Series = field(default_factory=pd.Series)
    daily_returns: pd.Series = field(default_factory=pd.Series)
    turnover: pd.Series = field(default_factory=pd.Series)
    positions: pd.Series = field(default_factory=pd.Series)
    n_holdings: pd.Series = field(default_factory=pd.Series)
    regimes: pd.Series = field(default_factory=pd.Series)


def run_backtest(
    signal: pd.DataFrame, close: pd.DataFrame,
    cfg: Config, regimes: pd.Series | None = None,
) -> BacktestResult:
    """Backtest with T+1 settlement, transaction costs, regime cash overlay."""
    common_dates = sorted(signal.index.intersection(close.index))
    common_symbols = sorted(signal.columns.intersection(close.columns))
    if len(common_dates) < 10:
        logger.error("Insufficient common dates (%d)", len(common_dates))
        return BacktestResult()

    signal = signal.loc[common_dates, common_symbols]
    close = close.loc[common_dates, common_symbols]
    n_dates = len(common_dates)

    cash = cfg.initial_capital
    holdings: dict[str, int] = {}
    equity_curve = [float(cfg.initial_capital)]
    ret_curve = [0.0]
    turn_curve = [0.0]
    pos_curve = [0]
    regime_curve: list[str] = []
    rebalance_dates = set(common_dates[0::cfg.rebalance_freq]) | {common_dates[0]}

    for i, date in enumerate(common_dates):
        if i == 0:
            regime = str(regimes.get(date, "NORMAL")) if regimes is not None else "NORMAL"
            regime_curve.append(regime)
            continue

        dt = pd.Timestamp(date)
        regime = str(regimes.get(dt, "NORMAL")) if regimes is not None else "NORMAL"
        regime_curve.append(regime)
        cash_ratio = REGIME_CASH.get(regime, 0.0)

        # Mark to market
        current_val = cash
        for sym, shares in list(holdings.items()):
            if sym in close.columns:
                px = float(close.loc[dt, sym])
                if not pd.isna(px) and px > 0:
                    current_val += shares * px
        current_equity = current_val

        # EMPTY liquidation
        if regime == "EMPTY" and holdings:
            for sym in list(holdings.keys()):
                if sym in close.columns:
                    px = float(close.loc[dt, sym])
                    if not pd.isna(px) and px > 0:
                        sell_val = holdings[sym] * px
                        cost = sell_val * (cfg.commission + cfg.stamp_tax)
                        cash += sell_val - cost
            holdings.clear()

        # Rebalance check
        if date in rebalance_dates and dt in signal.index:
            sig_today = signal.loc[dt].dropna().copy()
            prices_today = close.loc[dt]
            price_ok = set(prices_today[prices_today >= cfg.min_price].index)
            sig_today = sig_today[sig_today.index.intersection(price_ok)]

            if len(sig_today) >= max(3, cfg.top_n // 4):
                deployable = current_equity * (1.0 - cash_ratio)
                n_pick = min(cfg.top_n, len(sig_today))
                selected = sig_today.nlargest(n_pick)

                # Sell
                total_turnover = 0.0
                for sym in list(holdings.keys()):
                    if sym not in selected.index:
                        px = float(close.loc[dt, sym])
                        if not pd.isna(px) and px > 0:
                            sell_val = holdings[sym] * px
                            cost = sell_val * (cfg.commission + cfg.stamp_tax)
                            cash += sell_val - cost
                            total_turnover += sell_val
                        holdings.pop(sym, None)

                # Compute weights from signal (not equal weights)
                selected_sig = sig_today[selected.index]
                sig_abs = selected_sig.abs()
                sig_sum = sig_abs.sum()
                if sig_sum > 1e-10:
                    sig_weights = sig_abs / sig_sum
                else:
                    sig_weights = pd.Series(1.0 / n_pick, index=selected.index)

                # Buy
                for sym, w in sig_weights.items():
                    px = float(close.loc[dt, sym])
                    if pd.isna(px) or px < cfg.min_price:
                        continue
                    target_val = deployable * w
                    shares = max(int(target_val / px / 100) * 100, 100)
                    buy_val = shares * px
                    buy_cost = buy_val * (cfg.commission + cfg.slippage)
                    total_cost = buy_val + buy_cost
                    if total_cost <= cash and buy_val >= 100:
                        cash -= total_cost
                        holdings[sym] = holdings.get(sym, 0) + shares
                        total_turnover += buy_val

                turn_curve.append(total_turnover / max(current_equity, 1))
            else:
                turn_curve.append(0.0)
        else:
            turn_curve.append(0.0)

        new_equity = cash
        for sym, shares in holdings.items():
            if sym in close.columns:
                px = float(close.loc[dt, sym])
                if not pd.isna(px) and px > 0:
                    new_equity += shares * px

        daily_ret = new_equity / equity_curve[-1] - 1
        equity_curve.append(new_equity)
        ret_curve.append(daily_ret)
        pos_curve.append(len(holdings))

    date_idx = pd.DatetimeIndex(common_dates)
    return BacktestResult(
        equity=pd.Series(equity_curve, index=date_idx),
        daily_returns=pd.Series(ret_curve, index=date_idx),
        turnover=pd.Series(turn_curve, index=date_idx),
        n_holdings=pd.Series(pos_curve, index=date_idx),
        regimes=pd.Series(regime_curve, index=date_idx),
    )


# ═════════════════════════════════════════════════════════════════
# 5. Metrics & Reporting
# ═════════════════════════════════════════════════════════════════

def compute_metrics(bt: BacktestResult, cfg: Config, benchmark: pd.Series | None = None) -> dict[str, Any]:
    eq, dr = bt.equity, bt.daily_returns
    n = len(dr)
    if n < 5:
        return {"error": "Insufficient data", "n_trading_days": n}

    total_ret = float(eq.iloc[-1] / cfg.initial_capital - 1)
    ann_factor = 252.0 / n
    ann_ret = (1 + total_ret) ** ann_factor - 1 if total_ret > -1 else -1.0
    mean_r, std_r = float(dr.mean()), float(dr.std())
    sharpe = mean_r / max(std_r, 1e-10) * np.sqrt(252)
    cummax = eq.cummax()
    dd = (eq - cummax) / cummax
    max_dd = float(dd.min())
    calmar = abs(ann_ret / max(abs(max_dd), 0.01)) if max_dd < -0.01 else float("inf")

    neg_dr = dr[dr < 0]
    dd_sd = float(np.sqrt(np.mean(neg_dr ** 2)) * np.sqrt(252)) if len(neg_dr) > 5 else 0.0
    sortino = ann_ret / max(dd_sd, 0.001)

    win_rate = float((dr > 0).mean())
    vol = float(std_r * np.sqrt(252))

    bench_ret = 0.0
    if benchmark is not None and len(benchmark) >= 2:
        bm = benchmark.reindex(eq.index).dropna()
        if len(bm) >= 2:
            bench_ret = float(bm.iloc[-1] / bm.iloc[0] - 1)

    # Regime breakdown
    regime_breakdown: dict[str, dict] = {}
    if hasattr(bt, 'regimes') and not bt.regimes.empty:
        reg_df = pd.DataFrame({
            "return": dr.clip(-0.2, 0.2),
            "regime": bt.regimes,
        }).dropna()
        for r in sorted(reg_df["regime"].unique()):
            sub = reg_df[reg_df["regime"] == r]
            r_mean = float(sub["return"].mean())
            r_std = float(sub["return"].std()) if len(sub) > 1 else 0.0
            r_sharpe = r_mean / max(r_std, 1e-10) * np.sqrt(252) if r_std > 1e-10 else 0.0
            regime_breakdown[r] = {
                "n_days": len(sub),
                "mean_return": round(r_mean * 100, 3),
                "sharpe": round(r_sharpe, 2),
                "avg_exposure": round(r_sharpe * 100, 1),
                "total_return_pct": round(float((1 + sub["return"]).prod() - 1) * 100, 2),
            }

    avg_turn = float(bt.turnover.mean()) if hasattr(bt, 'turnover') and not bt.turnover.empty else 0.0
    avg_hold = float(bt.n_holdings.mean()) if hasattr(bt, 'n_holdings') and not bt.n_holdings.empty else 0

    return {
        "total_return_pct": round(total_ret * 100, 2),
        "annual_return_pct": round(ann_ret * 100, 2),
        "sharpe_ratio": round(sharpe, 2),
        "sortino_ratio": round(sortino, 2),
        "calmar_ratio": round(calmar, 2),
        "max_drawdown_pct": round(max_dd * 100, 2),
        "volatility_pct": round(vol * 100, 2),
        "win_rate_pct": round(win_rate * 100, 1),
        "benchmark_return_pct": round(bench_ret * 100, 2),
        "excess_return_pct": round((total_ret - bench_ret) * 100, 2),
        "avg_turnover_pct": round(avg_turn * 100, 2),
        "avg_holdings": round(avg_hold, 1),
        "n_trading_days": n,
        "final_capital": float(eq.iloc[-1]),
        "regime_breakdown": regime_breakdown,
    }


def print_report(metrics: dict[str, Any], elapsed: float, cfg: Config) -> None:
    print(f"\n{'='*62}")
    print(f"  BEST STRATEGY ULTIMATE — Performance Report")
    print(f"{'='*62}")
    print(f"  Period:      {cfg.start} → {cfg.end}")
    print(f"  Trading D:   {metrics.get('n_trading_days', '?')}")
    print(f"  Elapsed:     {elapsed:.1f}s")
    print(f"  Top-N:       {cfg.top_n} | Rebal: {cfg.rebalance_freq}d")
    print(f"  {'─'*58}")
    print(f"  {'':20s} {'Strategy':>10s} {'Bench':>10s} {'Excess':>10s}")
    print(f"  {'─'*58}")
    m = lambda k: metrics.get(k, 0)
    print(f"  {'Total Return':20s} {m('total_return_pct'):>+9.2f}%  {m('benchmark_return_pct'):>+9.2f}%  {m('excess_return_pct'):>+9.2f}%")
    print(f"  {'Annual Return':20s} {m('annual_return_pct'):>+9.2f}%")
    print(f"  {'─'*58}")
    print(f"  {'Sharpe':20s} {m('sharpe_ratio'):>9.2f}")
    print(f"  {'Sortino':20s} {m('sortino_ratio'):>9.2f}")
    print(f"  {'Calmar':20s} {m('calmar_ratio'):>9.2f}")
    print(f"  {'Max DD':20s} {m('max_drawdown_pct'):>+9.2f}%")
    print(f"  {'Volatility':20s} {m('volatility_pct'):>8.2f}%")
    print(f"  {'Win Rate':20s} {m('win_rate_pct'):>8.1f}%")
    print(f"  {'Turnover':20s} {m('avg_turnover_pct'):>8.2f}%")
    print(f"  {'Holdings':20s} {m('avg_holdings'):>8.0f}")
    print(f"  {'Final':20s} ¥{m('final_capital'):>10,.0f}")

    rb = metrics.get("regime_breakdown", {})
    if rb:
        print(f"\n  {'─'*58}")
        print(f"  Regime Breakdown")
        print(f"  {'─'*58}")
        for r in sorted(rb.keys()):
            rd = rb[r]
            print(f"  {r:12s} → {rd['n_days']:3d}d  ret={rd['total_return_pct']:+.2f}%  sharpe={rd['sharpe']:6.2f}  avg_ret={rd['mean_return']:+.3f}%")
    print(f"{'='*62}\n")


# ═════════════════════════════════════════════════════════════════
# 6. Output
# ═════════════════════════════════════════════════════════════════

def save_output(metrics: dict, bt: BacktestResult, cfg: Config, elapsed: float) -> Path:
    run_id = f"best_ultimate_{pd.Timestamp.now().strftime('%Y%m%d_%H%M%S')}_{np.random.randint(100000,999999)}"
    out_dir = OUTPUT_BASE / run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # JSON
    serializable = {
        "metrics": {k: v for k, v in metrics.items() if k != "regime_breakdown"},
        "regime_breakdown": metrics.get("regime_breakdown", {}),
        "config": {
            "start": cfg.start, "end": cfg.end,
            "top_n": cfg.top_n, "rebalance_freq": cfg.rebalance_freq,
            "n_factors": N_FACTORS,
            "factor_names": FACTOR_NAMES,
            "regime_weights": {k: v for k, v in REGIME_WEIGHTS.items()},
            "regime_cash": REGIME_CASH,
            "commission": cfg.commission,
            "stamp_tax": cfg.stamp_tax,
            "slippage": cfg.slippage,
        },
    }

    def fix(o):
        if isinstance(o, (np.integer,)): return int(o)
        if isinstance(o, (np.floating, np.float32, np.float64)): return float(o)
        if isinstance(o, np.bool_): return bool(o)
        if isinstance(o, dict): return {k: fix(v) for k, v in o.items()}
        if isinstance(o, list): return [fix(v) for v in o]
        return o

    (out_dir / "result.json").write_text(
        json.dumps(fix(serializable), indent=2, ensure_ascii=False))

    # Markdown report
    m = metrics
    lines = [
        "# Best Strategy Ultimate — Report",
        "",
        f"**Period**: {cfg.start} → {cfg.end}  |  **Top-N**: {cfg.top_n}  |  **Rebalance**: {cfg.rebalance_freq}d",
        "",
        "## Factor Model",
        f"Universe: {N_FACTORS} factors, regime-conditional weighting",
        "",
        "| Regime | Factor Emphasis | Cash % |",
        "|--------|----------------|--------|",
    ]
    for r in ["RISK_ON", "NORMAL", "CAUTIOUS", "DEFENSIVE"]:
        emph = ", ".join(f"{k}={v*100:.0f}%" for k, v in sorted(REGIME_WEIGHTS[r].items(), key=lambda x: -x[1])[:5])
        lines.append(f"| {r} | {emph} | {REGIME_CASH.get(r, 0)*100:.0f}% |")

    lines += [
        "",
        "## Performance",
        "| Metric | Strategy | Benchmark | Excess |",
        "|--------|----------|-----------|--------|",
        f"| Total Return | {m.get('total_return_pct', 0):+.2f}% | {m.get('benchmark_return_pct', 0):+.2f}% | {m.get('excess_return_pct', 0):+.2f}% |",
        f"| Annual Return | {m.get('annual_return_pct', 0):+.2f}% | — | — |",
        f"| Sharpe | {m.get('sharpe_ratio', 0):.2f} | — | — |",
        f"| Sortino | {m.get('sortino_ratio', 0):.2f} | — | — |",
        f"| Calmar | {m.get('calmar_ratio', 0):.2f} | — | — |",
        f"| Max DD | {m.get('max_drawdown_pct', 0):.2f}% | — | — |",
        f"| Volatility | {m.get('volatility_pct', 0):.2f}% | — | — |",
        f"| Win Rate | {m.get('win_rate_pct', 0):.1f}% | — | — |",
        f"| Turnover | {m.get('avg_turnover_pct', 0):.2f}% | — | — |",
        f"| Holdings | {m.get('avg_holdings', 0):.0f} | — | — |",
        f"| Final Capital | ¥{m.get('final_capital', 0):,.0f} | — | — |",
        "",
        "## Regime Breakdown",
    ]
    rb = m.get("regime_breakdown", {})
    if rb:
        lines += ["| Regime | Days | Return | Sharpe |", "|--------|------|--------|--------|"]
        for r in sorted(rb.keys()):
            rd = rb[r]
            lines.append(f"| {r} | {rd['n_days']} | {rd['total_return_pct']:+.2f}% | {rd['sharpe']:.2f} |")
    lines.append("")
    (out_dir / "report.md").write_text("\n".join(lines))

    # Daily equity
    if bt and hasattr(bt, "equity") and not bt.equity.empty:
        daily = pd.DataFrame({
            "equity": bt.equity, "return": bt.daily_returns,
            "turnover": bt.turnover, "holdings": bt.n_holdings,
            "regime": bt.regimes,
        })
        daily.to_parquet(out_dir / "daily_equity.parquet")

    # Manifest
    (out_dir / "manifest.json").write_text(json.dumps({
        "command": "best_strategy_ultimate",
        "start": cfg.start, "end": cfg.end,
        "exit_code": 0, "elapsed_seconds": round(elapsed, 1),
    }, indent=2))

    logger.info("Output: %s", out_dir)
    return out_dir


# ═════════════════════════════════════════════════════════════════
# 7. Pipeline
# ═════════════════════════════════════════════════════════════════

def run_pipeline(cfg: Config, quiet: bool = False) -> dict[str, Any]:
    t0 = time.time()
    if not quiet:
        logger.info("=" * 50)
        logger.info("Best Strategy Ultimate: %s → %s", cfg.start, cfg.end)

    # 1. Load factors
    factor_panels = load_factors_panel(cfg.start, cfg.end)
    if len(factor_panels) < 3:
        logger.error("Only %d factors loaded", len(factor_panels))
        return {"error": "Insufficient factors", "n_loaded": len(factor_panels)}

    if not quiet:
        loaded_info = [(n, f.shape) for n, f in factor_panels.items()]
        logger.info("Loaded %d/%d factors", len(factor_panels), N_FACTORS)

    # 2. Market data
    market = load_market_panel(cfg.start, cfg.end)
    if not market or "close" not in market:
        return {"error": "No market data"}
    close, ret = market["close"], market["ret"]

    # 3. Regime
    idx = load_index(cfg.index_code)
    regimes = pd.Series(dtype=object)
    if len(idx) > 10:
        s_dt = pd.Timestamp(cfg.start) - pd.Timedelta(days=90)
        warmup = idx[idx.index >= s_dt] if s_dt < idx.index[-1] else idx
        regimes = detect_regime(warmup, close)

    # 4. Build signal
    signal = build_composite_signal(factor_panels, regimes, REGIME_WEIGHTS)
    if signal.empty:
        return {"error": "Empty signal"}

    if not quiet:
        logger.info("Signal: %d dates, %d stocks avg", len(signal), signal.shape[1])

    # 5. Backtest
    bt = run_backtest(signal, close, cfg, regimes if not regimes.empty else None)

    # 6. Metrics
    metrics = compute_metrics(bt, cfg, idx)
    metrics["n_factors_loaded"] = len(factor_panels)

    elapsed = time.time() - t0
    if not quiet:
        logger.info("Done: Ret=%+.2f%% Sharpe=%.2f DD=%.2f%% [%.1fs]",
                     metrics.get("total_return_pct", 0),
                     metrics.get("sharpe_ratio", 0),
                     metrics.get("max_drawdown_pct", 0),
                     elapsed)
        print_report(metrics, elapsed, cfg)

    return {"metrics": metrics, "bt": bt, "signal": signal, "elapsed": elapsed}


def run_walk_forward(cfg: Config) -> dict[str, Any]:
    dates = pd.bdate_range(cfg.start, cfg.end)
    if len(dates) < cfg.walk_forward_folds * 10:
        return {"error": "Too few dates for walk-forward"}

    fold_size = len(dates) // cfg.walk_forward_folds
    folds, sharpes = [], []
    logger.info("Walk-forward: %d folds, %d dates/fold", cfg.walk_forward_folds, fold_size)

    for fold in range(cfg.walk_forward_folds):
        fs = dates[fold * fold_size].strftime("%Y-%m-%d")
        if fold == cfg.walk_forward_folds - 1:
            fe = dates[-1].strftime("%Y-%m-%d")
        else:
            fe = dates[(fold + 1) * fold_size - 1].strftime("%Y-%m-%d")

        fc = Config(start=fs, end=fe, top_n=cfg.top_n, rebalance_freq=cfg.rebalance_freq)
        try:
            result = run_pipeline(fc, quiet=True)
            if result and "metrics" in result:
                m = result["metrics"]
                if "error" not in m:
                    folds.append({
                        "fold": fold + 1, "start": fs, "end": fe,
                        "sharpe": m.get("sharpe_ratio", 0),
                        "ret": m.get("total_return_pct", 0),
                        "dd": m.get("max_drawdown_pct", 0),
                    })
                    sharpes.append(m.get("sharpe_ratio", 0))
                    logger.info("  Fold %d/%d: %s→%s Sharpe=%.2f Ret=%+.2f%%",
                                 fold+1, cfg.walk_forward_folds, fs, fe, sharpes[-1], m.get("total_return_pct", 0))
        except Exception as e:
            logger.warning("  Fold %d failed: %s", fold + 1, e)

    return {
        "walk_forward": {
            "n_folds": len(folds),
            "mean_sharpe": round(float(np.mean(sharpes)), 2) if sharpes else 0,
            "std_sharpe": round(float(np.std(sharpes)), 2) if sharpes else 0,
            "min_sharpe": round(float(min(sharpes)), 2) if sharpes else 0,
            "max_sharpe": round(float(max(sharpes)), 2) if sharpes else 0,
            "folds": folds,
        }
    }


# ═════════════════════════════════════════════════════════════════
# 8. CLI
# ═════════════════════════════════════════════════════════════════

def main() -> int:
    parser = argparse.ArgumentParser(description="Best Strategy Ultimate")
    parser.add_argument("--start", default="2026-01-05")
    parser.add_argument("--end", default="2026-07-01")
    parser.add_argument("--top-n", type=int, default=30)
    parser.add_argument("--rebalance", type=int, default=10)
    parser.add_argument("--walk-forward", type=int, default=0,
                        help="N-fold walk-forward cross-validation")
    parser.add_argument("--long-test", action="store_true",
                        help="Extended Jan→Jul test")
    args = parser.parse_args()

    cfg = Config(
        start=args.start, end=args.end,
        top_n=args.top_n, rebalance_freq=args.rebalance,
    )

    if args.long_test:
        cfg = Config(start="2026-01-05", end="2026-07-01",
                     top_n=cfg.top_n, rebalance_freq=cfg.rebalance_freq)

    if args.walk_forward >= 2:
        cfg.walk_forward_folds = args.walk_forward
        wf = run_walk_forward(cfg)
        if "error" in wf:
            print(f"Walk-forward error: {wf['error']}")
            return 1
        wf_info = wf["walk_forward"]
        print(f"\n{'='*62}")
        print(f"  WALK-FORWARD ({args.walk_forward} folds)")
        print(f"{'='*62}")
        for f in wf_info["folds"]:
            print(f"  Fold {f['fold']}: Sharpe={f['sharpe']:7.2f}  "
                  f"Ret={f['ret']:+7.2f}%  DD={f['dd']:6.2f}%")
        print(f"  {'─'*58}")
        print(f"  Mean Sharpe: {wf_info['mean_sharpe']:7.2f}  "
              f"Std: {wf_info['std_sharpe']:7.2f}")
        print(f"  Min: {wf_info['min_sharpe']:7.2f}  "
              f"Max: {wf_info['max_sharpe']:7.2f}")
        print(f"{'='*62}\n")
        return 0

    result = run_pipeline(cfg)
    if "error" in result:
        print(f"Error: {result['error']}")
        return 1

    out_dir = save_output(result["metrics"], result["bt"], cfg, result["elapsed"])
    print(f"  Output: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
