#!/usr/bin/env python3
"""
Regime-Conditional Factor Strategy
====================================

Empirically validated approach: market state (vol + breadth) determines
which factor families get the most weight. Based on analysis_v2's own
research confirming regime predictability (HIGH_VOL 90.8%, QUIET 64.5%)
and that factor IC differs materially across regimes.

Architecture:
  Layer 1: FactorCache loads 6 high-coverage factors (quality, flow, liquidity, risk)
  Layer 2: Regime detection (CSI300 vol percentile + A-stock breadth)
  Layer 3: Regime-conditional factor weighting
  Layer 4: Signal-weighted backtest with T+1, transaction cost, cash overlay

Usage:
  python3 scripts/regime_factor.py                          # 6-month test
  python3 scripts/regime_factor.py --start 2026-03-01 --end 2026-07-01
  python3 scripts/regime_factor.py --walk-forward 5         # 5-fold XVal

Output:
  output/regime_factor/<run_id>/    {result.json, report.md, manifest.json}

Author: Generated from analysis_v2 empirical analysis
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

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=RuntimeWarning)
warnings.filterwarnings("ignore", category=UserWarning)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────
AV2_ROOT = Path("/Users/fengzhi/Downloads/git2/analysis_v2")
assert AV2_ROOT.exists(), f"analysis_v2 not found: {AV2_ROOT}"

sys.path.insert(0, str(AV2_ROOT))
os.chdir(str(AV2_ROOT))  # FactorCache uses CWD for data_cache/

AV2_DC = AV2_ROOT / "data_cache"
IDX_DIR = AV2_DC / "market_data" / "daily" / "index_daily"

OUTPUT_BASE = Path("/Users/fengzhi/Downloads/git/testlixingren/output/regime_factor")

# ── Factor Universe (best coverage + diversified families) ────
# (name, direction, family, weight_riskon, weight_normal, weight_cautious, weight_defensive)
# Directions: pos=high is good, neg=low is good
FACTOR_DEFS: list[dict[str, Any]] = [
    {"name": "dim_quality",         "dir": "pos", "family": "Quality", "w": {"RISK_ON": 0.06, "NORMAL": 0.20, "CAUTIOUS": 0.25, "DEFENSIVE": 0.30}},
    {"name": "flow_net_mom_20",     "dir": "pos", "family": "Flow",    "w": {"RISK_ON": 0.30, "NORMAL": 0.20, "CAUTIOUS": 0.08, "DEFENSIVE": 0.02}},
    {"name": "liquidity_amihud",    "dir": "neg", "family": "Liquidity","w": {"RISK_ON": 0.06, "NORMAL": 0.15, "CAUTIOUS": 0.17, "DEFENSIVE": 0.18}},
    {"name": "defense_accrual_proxy","dir": "neg", "family": "Defensive","w": {"RISK_ON": 0.04, "NORMAL": 0.15, "CAUTIOUS": 0.20, "DEFENSIVE": 0.20}},
    {"name": "volatility_20",        "dir": "neg", "family": "Risk",    "w": {"RISK_ON": 0.04, "NORMAL": 0.15, "CAUTIOUS": 0.18, "DEFENSIVE": 0.20}},
    {"name": "cmf_20",              "dir": "pos", "family": "Flow",    "w": {"RISK_ON": 0.20, "NORMAL": 0.15, "CAUTIOUS": 0.12, "DEFENSIVE": 0.10}},
]

FACTOR_LOOKUP = {d["name"]: d for d in FACTOR_DEFS}
FACTOR_NAMES = [d["name"] for d in FACTOR_DEFS]
REGIME_LABELS = ["RISK_ON", "NORMAL", "CAUTIOUS", "DEFENSIVE", "EMPTY"]

# Cash ratio per regime
REGIME_CASH: dict[str, float] = {
    "RISK_ON": 0.00, "NORMAL": 0.00,
    "CAUTIOUS": 0.30, "DEFENSIVE": 0.50,
    "EMPTY": 1.00,
}


@dataclass
class Config:
    """Run configuration."""
    start: str = "2026-01-05"
    end: str = "2026-07-01"
    top_n: int = 20
    rebalance_freq: int = 5
    initial_capital: float = 1_000_000.0
    min_price: float = 2.0
    commission: float = 0.0003
    stamp_tax: float = 0.001
    slippage: float = 0.001
    min_dates: int = 30
    walk_forward_folds: int = 0
    volume_filter_pct: float = 0.0  # 0 = no filter

    run_id: str = field(default_factory=lambda: datetime.now().strftime("regime_%Y%m%d_%H%M%S_%f")[:24])


# ═════════════════════════════════════════════════════════════════
# 1. Data Loading
# ═════════════════════════════════════════════════════════════════

def load_factor_panels(start: str, end: str) -> dict[str, pd.DataFrame]:
    """Load factor panels via FactorCache (consistent lowercase symbols)."""
    from analysis_v2.core import FactorCache
    cache = FactorCache()

    panels: dict[str, pd.DataFrame] = {}
    for fd in FACTOR_DEFS:
        name = fd["name"]
        try:
            panel = cache.get(name, start, end)
        except Exception as e:
            logger.warning("  %s failed: %s", name, e)
            continue
        if panel is None or panel.empty:
            logger.warning("  %s: empty panel", name)
            continue
        n_dates, n_stocks = panel.shape
        coverage = panel.notna().mean().mean()
        panels[name] = panel
        logger.info("  %s: %d dates × %d stocks, coverage %.0f%%",
                     name, n_dates, n_stocks, coverage * 100)

    return panels


def load_market_panel(start: str, end: str) -> dict[str, pd.DataFrame]:
    """Load OHLCV via FactorCache (consistent lowercase symbols)."""
    from analysis_v2.core import FactorCache
    cache = FactorCache()
    raw = cache.load_market_panel(start, end)
    return raw  # keys: open/high/low/close/volume/amount


def load_index_series(idx_code: str = "000300.SH") -> pd.Series:
    """Load index close from parquet as Series[date → close]."""
    records: list[pd.Series] = []
    for pdir in sorted(IDX_DIR.iterdir()):
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
        logger.warning("Index %s: no data", idx_code)
        return pd.Series(dtype=np.float32)
    s = pd.concat(records).sort_index().astype(np.float32).dropna()
    logger.info("Index %s: %d days (%s → %s)", idx_code, len(s),
                 s.index[0].strftime("%Y-%m-%d"), s.index[-1].strftime("%Y-%m-%d"))
    return s


# ═════════════════════════════════════════════════════════════════
# 2. Regime Detection
# ═════════════════════════════════════════════════════════════════

def detect_regime(
    idx_close: pd.Series, mkt_close: pd.DataFrame,
    vol_window: int = 40, breadth_window: int = 20,
) -> pd.Series:
    """
    Detect market regime from CSI300 vol + A-stock breadth.

    Research basis (analysis_v2 docs):
      - Market state IS predictable (HIGH_VOL 90.8%, QUIET 64.5%)
      - Transfer matrix: regime shifts detectable 1d ahead >95%
      - Factor IC differs materially across regimes
    """
    # 1. Volatility regime (CSI300)
    ret = idx_close.pct_change().dropna()
    annual_vol = (ret.rolling(vol_window, min_periods=15).std() * np.sqrt(252)).dropna()
    if len(annual_vol) < 20:
        return pd.Series("NORMAL", index=pd.DatetimeIndex([pd.Timestamp.today()]))

    lv = float(annual_vol.quantile(0.33))
    hv = float(annual_vol.quantile(0.67))
    vol_regime = annual_vol.apply(lambda v: "QUIET" if v <= lv else ("HIGH" if v >= hv else "MID"))

    # 2. Breadth regime (A-stock % up)
    ret_m = mkt_close.pct_change()
    up_pct = (ret_m > 0).sum(axis=1).divide(ret_m.notna().sum(axis=1).replace(0, np.nan))
    breadth = up_pct.rolling(breadth_window, min_periods=5).mean().dropna()
    breadth_regime = breadth.apply(lambda b: "RISK_ON" if b >= 0.55 else ("DEFENSIVE" if b <= 0.40 else "NEUTRAL"))

    # 3. Combine into final regime (4 states)
    combo = pd.DataFrame({"vol": vol_regime, "brd": breadth_regime}).dropna()

    def _resolve(row: dict[str, str]) -> str:
        v, b = row["vol"], row["brd"]
        # High volatility + defensive breadth → EMPTY
        if v == "HIGH" and b == "DEFENSIVE":
            return "EMPTY"
        # High volatility → DEFENSIVE (capital preservation)
        if v == "HIGH":
            return "DEFENSIVE"
        # Low volatility + risk-on breadth → RISK_ON (risk appetite)
        if v == "QUIET" and b == "RISK_ON":
            return "RISK_ON"
        # Low volatility + neutral → NORMAL
        if v == "QUIET" and b == "NEUTRAL":
            return "NORMAL"
        # Mid volatility + risk-on → RISK_ON
        if v == "MID" and b == "RISK_ON":
            return "RISK_ON"
        # Mid volatility + defensive → CAUTIOUS
        if v == "MID" and b == "DEFENSIVE":
            return "CAUTIOUS"
        # Default → follow breadth regime or NORMAL
        if b == "DEFENSIVE":
            return "DEFENSIVE"
        if b == "RISK_ON":
            return "RISK_ON"
        return "NORMAL"

    regimes = combo.apply(_resolve, axis=1)
    dist = regimes.value_counts()
    logger.info("Regime dist: %s", dict(zip(dist.index.tolist(), dist.values.tolist())))
    return regimes


# ═════════════════════════════════════════════════════════════════
# 3. Signal Construction
# ═════════════════════════════════════════════════════════════════

def cross_sectional_rank(panel: pd.DataFrame, direction: str = "pos") -> pd.DataFrame:
    """Cross-sectional rank normalization to [-1, 1]."""
    r = panel.rank(axis=1, pct=True, na_option="keep")
    scaled = (r - 0.5) * 2.0
    if direction == "neg":
        scaled = -scaled
    return scaled


def build_composite_signal(
    factor_panels: dict[str, pd.DataFrame],
    regimes: pd.Series,
) -> pd.DataFrame:
    """Build regime-conditional composite factor signal.

    For each date:
      1. Get the regime's factor weights
      2. Rank-normalize each factor
      3. Weighted sum → composite signal
      4. If too few factors in a regime, fall back to equal weight
    """
    normed: dict[str, pd.DataFrame] = {}
    for name, panel in factor_panels.items():
        fd = FACTOR_LOOKUP.get(name)
        if fd is None:
            continue
        n = cross_sectional_rank(panel, fd["dir"])
        normed[name] = n

    if not normed:
        return pd.DataFrame(dtype=np.float32)

    all_dates = sorted({d for p in normed.values() for d in p.index})
    all_symbols = sorted(set.intersection(
        *[set(p.columns) for p in normed.values()]
    )) if len(normed) >= 2 else sorted(set().union(*[set(p.columns) for p in normed.values()]))

    composites: list[pd.Series] = []
    for dt in all_dates:
        dt_ts = pd.Timestamp(dt)
        regime = str(regimes.get(dt_ts, "NORMAL"))
        weights = {fd["name"]: fd["w"].get(regime, 0.0) for fd in FACTOR_DEFS}
        w_sum = sum(weights.values())
        if w_sum > 0:
            weights = {k: v / w_sum for k, v in weights.items()}

        # Build weighted sum of available factors
        weighted_rows: list[pd.Series] = []
        for name in FACTOR_NAMES:
            if name not in normed:
                continue
            w = weights.get(name, 0.0)
            if w <= 0:
                continue
            if dt not in normed[name].index:
                continue
            row = normed[name].loc[dt].dropna()
            if row.empty:
                continue
            weighted_rows.append(row * w)

        # Need at least 3 factors (or 50% of available) for reliable signal
        min_factors = max(2, len(FACTOR_NAMES) // 3)
        if len(weighted_rows) < min_factors:
            alt_rows: list[pd.Series] = []
            for name in FACTOR_NAMES:
                if name not in normed:
                    continue
                if dt not in normed[name].index:
                    continue
                row = normed[name].loc[dt].dropna()
                if not row.empty:
                    alt_rows.append(row)
            if len(alt_rows) < min_factors:
                continue
            composite = sum(alt_rows) / len(alt_rows)
        else:
            composite = sum(weighted_rows)

        composite.name = dt_ts
        composites.append(composite)

    if not composites:
        return pd.DataFrame(dtype=np.float32)

    signal = pd.DataFrame(composites).sort_index().astype(np.float32)
    logger.info("Signal: %d dates × %d stocks", *signal.shape)
    return signal


# ═════════════════════════════════════════════════════════════════
# 4. Backtest Engine
# ═════════════════════════════════════════════════════════════════

@dataclass
class BacktestResult:
    equity: pd.Series = field(default_factory=pd.Series)
    daily_returns: pd.Series = field(default_factory=pd.Series)
    turnover: pd.Series = field(default_factory=pd.Series)
    n_holdings: pd.Series = field(default_factory=pd.Series)
    regimes: pd.Series = field(default_factory=pd.Series)
    final_capital: float = 0.0
    total_return: float = 0.0


def run_backtest(
    signal: pd.DataFrame,
    close: pd.DataFrame,
    volume: pd.DataFrame | None,
    cfg: Config,
    regimes: pd.Series | None = None,
) -> BacktestResult:
    """Backtest with T+1 settlement, transaction cost, regime cash overlay.

    Key design:
      - Signal is observed at date t, traded at date t+1 close (T+1)
      - Top-N stocks selected by composite signal
      - Position weights proportional to signal strength
      - Commission + stamp tax + slippage on each trade
      - Cash overlay per regime (defensive regimes hold more cash)
    """
    # Find common dates with at least signal[1] (T+1 trade start)
    trade_dates = sorted(close.index[1:])  # first close is for T+1 from initial signal
    common_dates = sorted(set(trade_dates) & set(signal.index))
    if len(common_dates) < cfg.min_dates:
        logger.error("Only %d common dates (< %d)", len(common_dates), cfg.min_dates)
        return BacktestResult()

    # Align symbols
    common_symbols = sorted(set(signal.columns) & set(close.columns))
    if len(common_symbols) < 100:
        logger.error("Only %d common symbols", len(common_symbols))
        return BacktestResult()

    signal = signal.loc[common_dates, common_symbols]
    cls = close.loc[common_dates, common_symbols]
    vol = None
    if volume is not None:
        vol = volume.loc[common_dates, common_symbols]

    n_dates = len(common_dates)
    logger.info("Backtest: %d dates, %d symbols", n_dates, len(common_symbols))

    # States
    cash = float(cfg.initial_capital)
    holdings: dict[str, int] = {}
    p_prev: dict[str, float] = {}

    equity_curve = [float(cfg.initial_capital)]  # t=0 seed
    ret_curve = [0.0]
    turn_curve = [0.0]
    pos_curve = [0]
    regime_curve: list[str] = ["NORMAL"]

    rebalance_dates = {common_dates[i] for i in range(0, n_dates, cfg.rebalance_freq)}

    for i, date in enumerate(common_dates):
        dt = pd.Timestamp(date)
        regime = str(regimes.get(dt, "NORMAL")) if regimes is not None else "NORMAL"
        regime_curve.append(regime)

        cash_ratio = REGIME_CASH.get(regime, 0.0)
        px_today = cls.loc[dt]

        # ── Mark to market ──
        current_val = cash
        for sym in list(holdings.keys()):
            px = float(px_today.get(sym, np.nan))
            if pd.isna(px) or px <= 0:
                continue
            current_val += holdings[sym] * px
        current_equity = current_val

        # ── EMPTY liquidation (worst-case regime) ──
        if regime == "EMPTY" and holdings:
            for sym in list(holdings.keys()):
                px = float(px_today.get(sym, np.nan))
                if pd.isna(px) or px <= 0:
                    del holdings[sym]
                    continue
                sell_val = holdings[sym] * px
                cost = sell_val * (cfg.commission + cfg.stamp_tax)
                cash += sell_val - cost
                del holdings[sym]

        # ── Rebalance ──
        should_rebalance = date in rebalance_dates
        if should_rebalance and dt in signal.index:
            sig_today = signal.loc[dt].dropna().copy()

            # Price filter
            px_ok = set(px_today[px_today >= cfg.min_price].index)
            sig_today = sig_today[sig_today.index.intersection(px_ok)]

            # Volume filter (optional)
            if cfg.volume_filter_pct > 0 and vol is not None:
                vol_today = vol.loc[dt].dropna()
                if len(vol_today) > 100:
                    vol_ok = set(vol_today[vol_today > vol_today.quantile(cfg.volume_filter_pct)].index)
                    sig_today = sig_today[sig_today.index.intersection(vol_ok)]

            if len(sig_today) < 10:
                turn_curve.append(0.0)
                new_equity = cash
                for sym, shares in holdings.items():
                    px = float(px_today.get(sym, np.nan))
                    if pd.isna(px) or px <= 0:
                        continue
                    new_equity += shares * px
                daily_ret = new_equity / equity_curve[-1] - 1 if equity_curve[-1] > 0 else 0
                equity_curve.append(new_equity)
                ret_curve.append(daily_ret)
                pos_curve.append(len(holdings))
                continue

            # Select top-N stocks
            n_pick = min(cfg.top_n, len(sig_today))
            selected = sig_today.nlargest(n_pick)

            # ── Sell non-selected ──
            total_turnover = 0.0
            for sym in list(holdings.keys()):
                if sym not in selected.index:
                    px = float(px_today.get(sym, np.nan))
                    if pd.isna(px) or px <= 0:
                        holdings.pop(sym, None)
                        continue
                    sell_val = holdings[sym] * px
                    cost = sell_val * (cfg.commission + cfg.stamp_tax)
                    cash += sell_val - cost
                    total_turnover += sell_val
                    holdings.pop(sym, None)

            # ── Compute signal-weighted allocation ──
            deployable = current_equity * (1.0 - cash_ratio)
            sig_abs = selected.abs()
            sig_sum = sig_abs.sum()
            if sig_sum > 1e-10:
                sig_weights = sig_abs / sig_sum
            else:
                sig_weights = pd.Series(1.0 / n_pick, index=selected.index)

            # ── Buy ──
            for sym, w in sig_weights.items():
                px = float(px_today.get(sym, np.nan))
                if pd.isna(px) or px < cfg.min_price:
                    continue
                target_val = deployable * w
                shares = max(int(target_val / px / 100) * 100, 100)
                buy_val = shares * px
                buy_cost = buy_val * cfg.slippage
                total_cost = buy_val + buy_cost
                if total_cost <= cash:
                    cash -= total_cost
                    holdings[sym] = holdings.get(sym, 0) + shares
                    total_turnover += buy_val

            turnover_rate = total_turnover / max(current_equity, 1)
            turn_curve.append(turnover_rate)
        else:
            turn_curve.append(0.0)

        # ── Compute new equity ──
        new_equity = cash
        for sym, shares in list(holdings.items()):
            px = float(px_today.get(sym, np.nan))
            if pd.isna(px) or px <= 0:
                continue
            new_equity += shares * px

        daily_ret = new_equity / equity_curve[-1] - 1 if equity_curve[-1] > 0 else 0
        equity_curve.append(new_equity)
        ret_curve.append(daily_ret)
        pos_curve.append(len(holdings))

    # Final result
    date_index = pd.DatetimeIndex(common_dates)
    return BacktestResult(
        equity=pd.Series(equity_curve[1:], index=date_index),
        daily_returns=pd.Series(ret_curve[1:], index=date_index),
        turnover=pd.Series(turn_curve[1:], index=date_index),
        n_holdings=pd.Series(pos_curve[1:], index=date_index),
        regimes=pd.Series(regime_curve[1:], index=date_index),
        final_capital=float(equity_curve[-1]),
        total_return=float(equity_curve[-1] / equity_curve[0] - 1),
    )


# ═════════════════════════════════════════════════════════════════
# 5. Metrics
# ═════════════════════════════════════════════════════════════════

def compute_metrics(bt: BacktestResult, cfg: Config, idx: pd.Series) -> dict[str, Any]:
    """Compute strategy performance metrics."""
    if bt.equity.empty or len(bt.equity) < 20:
        return {"error": "Insufficient data", "n_trading_days": len(bt.equity)}

    rets = bt.daily_returns.values
    ret_index = bt.daily_returns.index
    n_days = len(rets)
    trading_days = 252
    period_years = n_days / trading_days
    if period_years <= 0:
        period_years = 0.01

    total_ret = bt.total_return
    annual_ret = (1 + total_ret) ** (1 / period_years) - 1
    volatility = float(np.std(rets, ddof=1) * np.sqrt(trading_days))
    sharpe = (annual_ret - 0.025) / volatility if volatility > 0 else 0.0  # assume 2.5% risk-free

    # Sortino
    neg_rets = rets[rets < 0]
    downside = float(np.std(neg_rets, ddof=1)) * np.sqrt(trading_days) if len(neg_rets) > 5 else 0.01
    sortino = (annual_ret - 0.025) / downside if downside > 0 else 0.0

    # Max drawdown
    cummax = np.maximum.accumulate(bt.equity.values)
    dd = (bt.equity.values - cummax) / cummax
    max_dd = float(np.min(dd))
    calmar = annual_ret / abs(max_dd) if abs(max_dd) > 0 else 0.0

    # Win rate
    win_rate = float(np.sum(rets > 0) / max(len(rets), 1))

    # Turnover
    avg_turnover = float(np.mean(bt.turnover.values)) if len(bt.turnover) > 0 else 0.0
    avg_holdings = float(np.mean(bt.n_holdings.values)) if len(bt.n_holdings) > 0 else 0.0

    # Benchmark
    bench_ret = 0.0
    bench_sharpe = 0.0
    if len(idx) > 20:
        idx_aligned = idx.reindex(ret_index, method="ffill")
        if len(idx_aligned) > 10:
            idx_rets = idx_aligned.pct_change().dropna().values[:n_days]
            if len(idx_rets) > 10:
                bench_total = float(idx_aligned.iloc[-1] / idx_aligned.iloc[0] - 1) if len(idx_aligned) > 1 else 0
                bench_ret = bench_total
                bench_vol = float(np.std(idx_rets, ddof=1) * np.sqrt(trading_days))
                bench_sharpe = (bench_total / period_years - 0.025) / bench_vol if bench_vol > 0 else 0.0

    # Regime breakdown
    regime_breakdown: dict[str, dict[str, Any]] = {}
    if not bt.regimes.empty:
        for r in bt.regimes.unique():
            mask = bt.regimes == r
            n_days_r = int(mask.sum())
            if n_days_r < 3:
                continue
            r_rets = bt.daily_returns[mask].values
            r_total = float(np.prod(1 + r_rets) - 1) if len(r_rets) > 0 else 0
            r_vol = float(np.std(r_rets, ddof=1) * np.sqrt(trading_days)) if len(r_rets) > 5 else 0
            r_sharpe = (r_total / max(len(r_rets) / trading_days, 0.01) - 0.025) / max(r_vol, 0.01)
            regime_breakdown[r] = {
                "n_days": n_days_r,
                "total_return_pct": round(r_total * 100, 2),
                "sharpe": round(float(r_sharpe), 2),
            }

    return {
        "total_return_pct": round(total_ret * 100, 2),
        "annual_return_pct": round(annual_ret * 100, 2),
        "sharpe_ratio": round(sharpe, 3),
        "sortino_ratio": round(sortino, 3),
        "calmar_ratio": round(calmar, 3),
        "max_drawdown_pct": round(max_dd * 100, 2),
        "volatility_pct": round(volatility * 100, 2),
        "win_rate_pct": round(win_rate * 100, 1),
        "avg_turnover_pct": round(avg_turnover * 100, 2),
        "avg_holdings": round(avg_holdings, 0),
        "n_trading_days": n_days,
        "period_years": round(period_years, 2),
        "final_capital": round(bt.final_capital, 2),
        "benchmark_return_pct": round(bench_ret * 100, 2),
        "benchmark_sharpe": round(bench_sharpe, 3),
        "excess_return_pct": round((total_ret - bench_ret) * 100, 2),
        "regime_breakdown": regime_breakdown,
        "n_factors_loaded": len(FACTOR_DEFS),
    }


def print_report(metrics: dict[str, Any], elapsed: float, cfg: Config) -> str:
    """Generate Markdown report."""
    lines = [
        f"# Regime-Conditional Factor Strategy — Report",
        f"",
        f"**Period**: {cfg.start} → {cfg.end}  |  **Top-N**: {cfg.top_n}"
        f"  |  **Rebalance**: {cfg.rebalance_freq}d",
        f"",
    ]

    if "error" in metrics:
        lines.append(f"**Error**: {metrics['error']}")
        lines.append("")
        return "\n".join(lines)

    m = metrics

    # Factor model
    lines += [
        f"## Factor Model",
        f"{'| Factor | Family | Direction |':s}",
        f"{'|--------|--------|-----------|':s}",
    ]
    for fd in FACTOR_DEFS:
        lines.append(f"| {fd['name']} | {fd['family']} | {fd['dir']} |")

    # Regime weights
    lines += ["", "## Regime Weights"]
    header = "| Regime | " + " | ".join(fd["name"] for fd in FACTOR_DEFS) + " | Cash |"
    sep = "|--------|" + "|".join("---" for _ in FACTOR_DEFS) + "|------|"
    lines += [header, sep]
    for regime in ["RISK_ON", "NORMAL", "CAUTIOUS", "DEFENSIVE", "EMPTY"]:
        ws = [f"{fd['w'].get(regime, 0)*100:.0f}%" for fd in FACTOR_DEFS]
        cash = f"{REGIME_CASH.get(regime, 0)*100:.0f}%"
        lines.append(f"| {regime} | {' | '.join(ws)} | {cash} |")

    # Performance
    lines += ["", "## Performance"]
    lines += [
        f"| Metric | Strategy | Benchmark | Excess |",
        f"|--------|----------|-----------|--------|",
        f"| Total Return | {m.get('total_return_pct', 0):+.2f}% | {m.get('benchmark_return_pct', 0):+.2f}% | {m.get('excess_return_pct', 0):+.2f}% |",
        f"| Annual Return | {m.get('annual_return_pct', 0):+.2f}% | — | — |",
        f"| Sharpe | {m.get('sharpe_ratio', 0):.3f} | {m.get('benchmark_sharpe', 0):.3f} | — |",
        f"| Sortino | {m.get('sortino_ratio', 0):.3f} | — | — |",
        f"| Calmar | {m.get('calmar_ratio', 0):.3f} | — | — |",
        f"| Max DD | {m.get('max_drawdown_pct', 0):.2f}% | — | — |",
        f"| Volatility | {m.get('volatility_pct', 0):.2f}% | — | — |",
        f"| Win Rate | {m.get('win_rate_pct', 0):.1f}% | — | — |",
        f"| Turnover | {m.get('avg_turnover_pct', 0):.2f}% | — | — |",
        f"| Holdings | {m.get('avg_holdings', 0):.0f} | — | — |",
        f"| Final Capital | ¥{m.get('final_capital', 0):,.0f} | — | — |",
        f"| Trading Days | {m.get('n_trading_days', 0):d} | — | — |",
    ]

    # Regime breakdown
    rb = m.get("regime_breakdown", {})
    if rb:
        lines += ["", "## Regime Breakdown",
                  "| Regime | Days | Return | Sharpe |",
                  "|--------|------|--------|--------|"]
        for r in sorted(rb.keys()):
            rd = rb[r]
            lines.append(f"| {r} | {rd['n_days']} | {rd['total_return_pct']:+.2f}% | {rd['sharpe']:.2f} |")

    lines.append("")
    return "\n".join(lines)


def save_output(metrics: dict, bt: BacktestResult, cfg: Config, elapsed: float) -> Path:
    """Save result.json, report.md, manifest.json."""
    out_dir = OUTPUT_BASE / cfg.run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # result.json (metrics only, machine-readable)
    m_out = {k: v for k, v in metrics.items() if k != "regime_breakdown"}
    if "error" not in metrics:
        r = {
            "metrics": m_out,
            "regime_breakdown": metrics.get("regime_breakdown", {}),
            "config": {
                "start": cfg.start, "end": cfg.end, "top_n": cfg.top_n,
                "rebalance_freq": cfg.rebalance_freq, "n_factors": len(FACTOR_DEFS),
                "factor_names": FACTOR_NAMES,
                "regime_cash": REGIME_CASH,
                "commission": cfg.commission, "stamp_tax": cfg.stamp_tax,
                "slippage": cfg.slippage,
            },
        }
    else:
        r = {"metrics": metrics, "config": {"start": cfg.start, "end": cfg.end}}
    (out_dir / "result.json").write_text(json.dumps(r, indent=2, ensure_ascii=False))

    # report.md (human-readable)
    report = print_report(metrics, elapsed, cfg)
    (out_dir / "report.md").write_text(report, encoding="utf-8")

    # Daily equity
    if bt and bt.equity is not None and len(bt.equity) > 0:
        daily = pd.DataFrame({
            "equity": bt.equity, "return": bt.daily_returns,
            "turnover": bt.turnover, "holdings": bt.n_holdings,
            "regime": bt.regimes,
        })
        daily.to_parquet(out_dir / "daily_equity.parquet")

    # manifest.json
    (out_dir / "manifest.json").write_text(json.dumps({
        "command": "regime_factor",
        "start": cfg.start, "end": cfg.end,
        "exit_code": 0, "elapsed_seconds": round(elapsed, 1),
    }, indent=2))

    logger.info("Output: %s", out_dir)
    return out_dir


# ═════════════════════════════════════════════════════════════════
# 6. Pipeline
# ═════════════════════════════════════════════════════════════════

def run_pipeline(cfg: Config) -> dict[str, Any]:
    """Run the full pipeline: load data → detect regime → build signal → backtest → metrics."""
    t0 = time.time()
    logger.info("=" * 55)
    logger.info("Regime Factor Strategy: %s → %s", cfg.start, cfg.end)

    # 1. Load factors (via FactorCache)
    logger.info("[1/5] Loading factor panels...")
    factor_panels = load_factor_panels(cfg.start, cfg.end)
    if len(factor_panels) < 2:
        return {"error": f"Insufficient factors ({len(factor_panels)})", "n_loaded": len(factor_panels)}
    logger.info("  → %d factors loaded", len(factor_panels))

    # 2. Load market data
    logger.info("[2/5] Loading market data...")
    market = load_market_panel(cfg.start, cfg.end)
    if not market or "close" not in market or market["close"].empty:
        return {"error": "No market data"}
    close = market["close"].astype(np.float32)
    volume = market.get("volume")
    logger.info("  → %d dates × %d symbols", close.shape[0], close.shape[1])

    # 3. Load index for regime detection
    logger.info("[3/5] Loading index data for regime detection...")
    idx = load_index_series("000300.SH")
    if len(idx) < 20:
        logger.warning("Index data insufficient, using default NORMAL regime")

    # 4. Detect regime
    logger.info("[4/5] Detecting market regime...")
    regimes = detect_regime(idx, close) if len(idx) >= 20 else pd.Series("NORMAL", index=idx.index)

    # 5. Build signal
    logger.info("[5/5] Building composite signal...")
    signal = build_composite_signal(factor_panels, regimes)
    if signal.empty:
        return {"error": "Empty composite signal"}

    # 6. Backtest
    bt = run_backtest(signal, close, volume, cfg, regimes)
    if bt.equity.empty or len(bt.equity) < 20:
        return {"error": "Backtest produced no trades or insufficient data"}

    # 7. Metrics
    metrics = compute_metrics(bt, cfg, idx)
    elapsed = time.time() - t0

    logger.info("=" * 55)
    if "error" in metrics:
        logger.error("Error: %s", metrics["error"])
    else:
        logger.info("Result: Ret=%+.2f%%  Sharpe=%.3f  DD=%.2f%%  [%.1fs]",
                     metrics.get("total_return_pct", 0),
                     metrics.get("sharpe_ratio", 0),
                     metrics.get("max_drawdown_pct", 0),
                     elapsed)

    return {"metrics": metrics, "bt": bt, "signal": signal, "elapsed": elapsed}


def run_walk_forward(cfg: Config) -> dict[str, Any]:
    """Walk-forward cross-validation."""
    dates = pd.bdate_range(cfg.start, cfg.end)
    if len(dates) < cfg.walk_forward_folds * 20:
        return {"error": f"Too few dates for {cfg.walk_forward_folds}-fold WF"}

    fold_size = len(dates) // cfg.walk_forward_folds
    folds_list, sharpes = [], []
    logger.info("Walk-forward: %d folds, ~%d dates/fold", cfg.walk_forward_folds, fold_size)

    for fold in range(cfg.walk_forward_folds):
        fs = dates[fold * fold_size].strftime("%Y-%m-%d")
        fe = dates[(fold + 1) * fold_size - 1].strftime("%Y-%m-%d") if fold < cfg.walk_forward_folds - 1 else dates[-1].strftime("%Y-%m-%d")

        fc = Config(start=fs, end=fe, top_n=cfg.top_n, rebalance_freq=cfg.rebalance_freq)
        try:
            result = run_pipeline(fc)
            if result and "metrics" in result:
                m = result["metrics"]
                if "error" not in m:
                    folds_list.append({
                        "fold": fold + 1, "start": fs, "end": fe,
                        "sharpe": m.get("sharpe_ratio", 0),
                        "ret": m.get("total_return_pct", 0),
                        "dd": m.get("max_drawdown_pct", 0),
                    })
                    sharpes.append(m.get("sharpe_ratio", 0))
                    logger.info("  Fold %d/%d: %s→%s Sharpe=%.3f Ret=%+.2f%%",
                                 fold + 1, cfg.walk_forward_folds, fs, fe,
                                 sharpes[-1], m.get("total_return_pct", 0))
        except Exception as e:
            logger.warning("  Fold %d failed: %s", fold + 1, e)

    if not sharpes:
        return {"error": "All WF folds failed"}

    return {
        "walk_forward": {
            "n_folds": len(folds_list),
            "mean_sharpe": round(float(np.mean(sharpes)), 3),
            "std_sharpe": round(float(np.std(sharpes)), 3),
            "min_sharpe": round(float(min(sharpes)), 3),
            "max_sharpe": round(float(max(sharpes)), 3),
            "folds": folds_list,
        }
    }


# ═════════════════════════════════════════════════════════════════
# 7. CLI
# ═════════════════════════════════════════════════════════════════

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Regime-Conditional Factor Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 scripts/regime_factor.py
  python3 scripts/regime_factor.py --start 2026-03-01 --end 2026-07-01 --top-n 30
  python3 scripts/regime_factor.py --walk-forward 5
  python3 scripts/regime_factor.py --list-factors
        """,
    )
    parser.add_argument("--start", default="2026-01-05")
    parser.add_argument("--end", default="2026-07-01")
    parser.add_argument("--top-n", type=int, default=20)
    parser.add_argument("--rebalance", type=int, default=5)
    parser.add_argument("--walk-forward", type=int, default=0, help="N-fold WF")
    parser.add_argument("--list-factors", action="store_true", help="List factor definitions")
    parser.add_argument("--long-test", action="store_true", help="Full 6mo test")

    args = parser.parse_args()

    if args.list_factors:
        print(f"\n{'Factor':25s} {'Family':15s} {'Dir':5s} {'RISK_ON':8s} {'NORMAL':8s} {'CAUTIOUS':10s} {'DEFENSIVE':10s}")
        print("-" * 80)
        for fd in FACTOR_DEFS:
            w = fd["w"]
            print(f"{fd['name']:25s} {fd['family']:15s} {fd['dir']:5s}"
                  f" {w['RISK_ON']*100:6.0f}% {w['NORMAL']*100:6.0f}%"
                  f" {w['CAUTIOUS']*100:8.0f}% {w['DEFENSIVE']*100:8.0f}%")
        print()
        return 0

    cfg = Config(
        start=args.start, end=args.end,
        top_n=args.top_n, rebalance_freq=args.rebalance,
    )
    if args.long_test:
        cfg = Config(start="2026-01-05", end="2026-07-01",
                     top_n=args.top_n, rebalance_freq=args.rebalance_freq)

    if args.walk_forward >= 2:
        cfg.walk_forward_folds = args.walk_forward
        result = run_walk_forward(cfg)
        if "error" in result:
            print(f"Walk-forward error: {result['error']}")
            return 1
        wf = result["walk_forward"]
        print(f"\n{'='*62}")
        print(f"  WALK-FORWARD ({args.walk_forward} folds)")
        print(f"{'='*62}")
        for f in wf["folds"]:
            print(f"  Fold {f['fold']}: Sharpe={f['sharpe']:7.3f}  Ret={f['ret']:+7.2f}%  DD={f['dd']:6.2f}%")
        print(f"  {'─'*58}")
        print(f"  Mean Sharpe: {wf['mean_sharpe']:7.3f}  Std: {wf['std_sharpe']:7.3f}")
        print(f"  Min: {wf['min_sharpe']:7.3f}  Max: {wf['max_sharpe']:7.3f}")
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
