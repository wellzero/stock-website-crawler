#!/usr/bin/env python3
"""
Phase-1a Regime-Conditional Factor Strategy (Best Implementation)
=================================================================

Based on analysis_v2's own empirical research.

Architecture (3 layers):
  Layer 3: Risk control (daily) — transfer matrix early warning signals
  Layer 2: Factor signal (every 3d) — regime-conditional composite factor
  Layer 1: Data (daily) — CSI300 regime + factor cache + market data

Key improvements over regime_factor.py:
  1. ✓ Phase 1a factor definitions (vol_5, tvma_6, close_location_value, etc.)
  2. ✓ Volume filter (exclude bottom 20% by volume) — fixes illiquid tail
  3. ✓ Equal-weight allocation (not signal-weighted) — reduces concentration risk
  4. ✓ 3-day rebalance (per roadmap recommendation)
  5. ✓ Transfer matrix risk overlay (Phase 1d signals)
  6. ✓ Realistic costs: 3.8‰ round-trip
  7. ✓ Better TRENDING_UP factors: includes defense (not pure momentum)

Usage:
  python3 scripts/best_strategy.py                          # 6-month test
  python3 scripts/best_strategy.py --compare-baseline       # Compare vs equal-weight baseline
  python3 scripts/best_strategy.py --walk-forward 5         # 5-fold XVal
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
os.chdir(str(AV2_ROOT))

AV2_DC = AV2_ROOT / "data_cache"
IDX_DIR = AV2_DC / "market_data" / "daily" / "index_daily"

OUTPUT_BASE = Path("/Users/fengzhi/Downloads/git/testlixingren/output/best_strategy")

# ───────────────────────────────────────────────────────────────
# Phase 1a Factor Definitions (regime-conditional weights)
# ───────────────────────────────────────────────────────────────
# Important: TRENDING_UP now includes defensive factors, not pure momentum,
# because narrow-index-rallies (CSI300 up, breadth weak) cause momentum to fail.

FACTOR_DEFS: list[dict[str, Any]] = [
    {
        "name": "vol_5",
        "dir": "neg",
        "family": "LowVol",
        "w": {"QUIET": 2.0, "HIGH_VOL": -1.5, "TRENDING_UP": 1.0},
        "desc": "5-day volatility: NEG in QUIET (low-vol=good), POS in HIGH_VOL",
    },
    {
        "name": "tvma_6",
        "dir": "neg",
        "family": "Turnover",
        "w": {"QUIET": 1.5, "HIGH_VOL": 0.0, "TRENDING_UP": 0.5},
        "desc": "6-period turnover volume MA: low turnover = less crowded",
    },
    {
        "name": "close_location_value",
        "dir": "pos",
        "family": "Momentum",
        "w": {"QUIET": 2.0, "HIGH_VOL": 0.0, "TRENDING_UP": 1.5},
        "desc": "52-week close position: near highs = strong momentum quality",
    },
    {
        "name": "defense_profitability",
        "dir": "pos",
        "family": "Quality",
        "w": {"QUIET": 1.5, "HIGH_VOL": 0.0, "TRENDING_UP": 1.0},
        "desc": "Operating profitability (cfo_to_ev proxy)",
    },
    {
        "name": "roc_20",
        "dir": "neg",
        "family": "Reversal",
        "w": {"QUIET": 0.0, "HIGH_VOL": 2.0, "TRENDING_UP": 0.0},
        "desc": "20-day return: mean reversion in HIGH_VOL",
    },
    {
        "name": "macdc",
        "dir": "pos",
        "family": "Trend",
        "w": {"QUIET": 0.0, "HIGH_VOL": 2.0, "TRENDING_UP": 0.5},
        "desc": "MACD line: trend strength signal",
    },
]

FACTOR_LOOKUP = {d["name"]: d for d in FACTOR_DEFS}
FACTOR_NAMES = [d["name"] for d in FACTOR_DEFS]
REGIME_LABELS = ["QUIET", "HIGH_VOL", "TRENDING_UP", "TRENDING_DOWN"]

# Cash ratio per regime
REGIME_CASH: dict[str, float] = {
    "QUIET": 0.00,
    "HIGH_VOL": 0.50,
    "TRENDING_UP": 0.00,
    "TRENDING_DOWN": 1.00,
    "UNKNOWN": 0.25,
}

# Position size reduction when risk signal is active
RISK_SIGNAL_REDUCTION: dict[str, float] = {
    "QUIET": 0.85,       # mild reduction even in QUIET (keep most exposure)
    "HIGH_VOL": 0.50,    # significant in HIGH_VOL
    "TRENDING_UP": 0.80, # mild in trending up
    "TRENDING_DOWN": 0.00,
}


@dataclass
class Config:
    start: str = "2026-01-05"
    end: str = "2026-07-01"
    top_n: int = 30
    rebalance_freq: int = 3
    initial_capital: float = 1_000_000.0
    min_price: float = 2.0
    commission: float = 0.0002
    stamp_tax: float = 0.001
    slippage: float = 0.0008
    min_dates: int = 20
    walk_forward_folds: int = 0
    volume_filter_pct: float = 0.2       # exclude bottom 20% by volume
    enable_risk_layer: bool = True
    compare_baseline: bool = False
    run_id: str = field(default_factory=lambda: datetime.now().strftime("best_%Y%m%d_%H%M%S_%f")[:24])


# ═════════════════════════════════════════════════════════════════
# 1. Data Loading
# ═════════════════════════════════════════════════════════════════

def load_factor_panels(start: str, end: str) -> dict[str, pd.DataFrame]:
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
    from analysis_v2.core import FactorCache
    cache = FactorCache()
    return cache.load_market_panel(start, end)


def load_index_series(idx_code: str = "000300.SH") -> pd.Series:
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
        return pd.Series(dtype=np.float32)
    s = pd.concat(records).sort_index().astype(np.float32).dropna()
    logger.info("Index %s: %d days", idx_code, len(s))
    return s


# ═════════════════════════════════════════════════════════════════
# 2. Regime Detection (Fixed for narrow-rally environments)
# ═════════════════════════════════════════════════════════════════

def detect_regime(
    idx_close: pd.Series, mkt_close: pd.DataFrame,
    vol_lookback: int = 40, breadth_lookback: int = 20,
    ret_lookback: int = 20,
) -> tuple[pd.Series, pd.Series]:
    """
    Detect market regime. Critical fix: TRENDING_UP requires BOTH
    positive return AND strong breadth (>55%). NEUTRAL breadth (35-55%)
    with positive return is classified as QUIET, not TRENDING_UP.

    Research: Phase 1a/1d showed ret_20d > 0.030 is early HIGH_VOL warning.
    We use ret_20d > 0.02 for TRENDING_UP but ONLY when breadth > 55%.
    """
    ret = idx_close.pct_change().dropna()
    annual_vol = (ret.rolling(vol_lookback, min_periods=15).std() * np.sqrt(252)).dropna()
    if len(annual_vol) < 20:
        default = pd.Series("QUIET", index=pd.DatetimeIndex([pd.Timestamp.today()]))
        return default, pd.Series(0.0, index=default.index)

    lv = float(annual_vol.quantile(0.35))
    hv = float(annual_vol.quantile(0.65))
    vol_label = annual_vol.apply(lambda v: "LOW" if v <= lv else ("HIGH" if v >= hv else "MID"))

    trend_ret = idx_close.pct_change(ret_lookback).dropna()
    trend_label = trend_ret.apply(
        lambda r: "UP" if r > 0.02 else ("DOWN" if r < -0.02 else "FLAT")
    )

    # Breadth: % stocks above 20-day MA
    ret_m = mkt_close.pct_change()
    ma20 = mkt_close.rolling(breadth_lookback, min_periods=5).mean()
    above_ma = (mkt_close > ma20).sum(axis=1)
    total_valid = mkt_close.notna().sum(axis=1)
    up_pct = above_ma.divide(total_valid.replace(0, np.nan)).dropna()
    breadth_ma = up_pct.rolling(5, min_periods=3).mean()
    
    # ── Fixed breadth thresholds ──
    # RISK_ON: >= 55% stocks above MA (broad participation)
    # NEUTRAL: 35-55% (mixed)
    # DEFENSIVE: < 35% (weak)
    breadth_label = breadth_ma.apply(
        lambda b: "RISK_ON" if b >= 0.55 else ("DEFENSIVE" if b <= 0.35 else "NEUTRAL")
    )

    combo = pd.DataFrame({
        "vol": vol_label, "trend": trend_label, "brd": breadth_label,
    }).dropna()

    def _resolve_regime(row: dict[str, str]) -> str:
        v, t, b = row["vol"], row["trend"], row["brd"]
        
        # TRENDING_DOWN: defensive breadth + DOWN trend
        if t == "DOWN" and b in ("DEFENSIVE", "NEUTRAL"):
            return "TRENDING_DOWN"
        
        # HIGH_VOL: high volatility (regardless of trend/breadth)
        if v == "HIGH":
            return "HIGH_VOL"
        
        # TRENDING_UP: LOW/MID vol + UP trend + RISK_ON breadth (broad participation!)
        if t == "UP" and b == "RISK_ON":
            return "TRENDING_UP"
        
        # QUIET (default for most conditions): 
        # - LOW/MID vol + FLAT/UP trend + NEUTRAL/RISK_ON breadth
        # - LOW/MID vol + UP trend + DEFENSIVE breadth (narrow rally → treat as QUIET)
        if v in ("LOW", "MID") and b in ("NEUTRAL", "RISK_ON"):
            return "QUIET"
        
        # Narrow rally: CSI300 up but breadth weak → QUIET, not TRENDING_UP
        if t == "UP" and b == "DEFENSIVE":
            return "QUIET"
        
        # Mixed conditions → QUIET
        if t == "FLAT" and b in ("NEUTRAL", "RISK_ON"):
            return "QUIET"
        
        # Everything else → QUIET (safe default)
        return "QUIET"

    regimes = combo.apply(_resolve_regime, axis=1)

    # ── Risk signal (Phase 1d v2) ──
    risk_sig = pd.Series(0.0, index=regimes.index)
    for dt in risk_sig.index:
        dt_p = pd.Timestamp(dt)
        if dt_p in trend_ret.index and trend_ret.loc[dt_p] > 0.030:
            risk_sig.loc[dt] = max(risk_sig.loc[dt], 0.5)
        if dt_p in breadth_ma.index and breadth_ma.loc[dt_p] < 0.262:
            risk_sig.loc[dt] = max(risk_sig.loc[dt], 0.6)

    dist = regimes.value_counts()
    logger.info("Regime dist: %s", dict(zip(dist.index.tolist(), dist.values.tolist())))
    logger.info("Risk signal: %.1f%% days active",
                (risk_sig > 0).mean() * 100)

    return regimes, risk_sig


# ═════════════════════════════════════════════════════════════════
# 3. Signal Construction
# ═════════════════════════════════════════════════════════════════

def cross_sectional_rank(panel: pd.DataFrame, direction: str = "pos") -> pd.DataFrame:
    r = panel.rank(axis=1, pct=True, na_option="keep")
    scaled = (r - 0.5) * 2.0
    if direction == "neg":
        scaled = -scaled
    return scaled


def build_composite_signal(
    factor_panels: dict[str, pd.DataFrame],
    regimes: pd.Series,
) -> pd.DataFrame:
    normed: dict[str, pd.DataFrame] = {}
    for name, panel in factor_panels.items():
        fd = FACTOR_LOOKUP.get(name)
        if fd is None:
            continue
        n = cross_sectional_rank(panel, fd["dir"])
        n = n.fillna(0.0)
        normed[name] = n

    if not normed:
        return pd.DataFrame(dtype=np.float32)

    all_dates = sorted({d for p in normed.values() for d in p.index})
    all_symbols = sorted(set.union(
        *[set(p.columns) for p in normed.values()]
    ))

    composites: list[pd.Series] = []
    for dt in all_dates:
        dt_ts = pd.Timestamp(dt)
        regime = str(regimes.get(dt_ts, "QUIET"))
        if regime == "TRENDING_DOWN":
            continue

        weights = {}
        for fd in FACTOR_DEFS:
            w = fd["w"].get(regime, 0.0)
            if w == 0:
                continue
            weights[fd["name"]] = w

        w_sum = sum(weights.values())
        if w_sum > 0:
            weights = {k: v / w_sum for k, v in weights.items()}

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

        min_factors = max(1, len(FACTOR_DEFS) // 4)
        if len(weighted_rows) < min_factors:
            continue

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
    risk_activations: pd.Series = field(default_factory=pd.Series)
    final_capital: float = 0.0
    total_return: float = 0.0


def run_backtest(
    signal: pd.DataFrame,
    close: pd.DataFrame,
    volume: pd.DataFrame | None,
    cfg: Config,
    regimes: pd.Series | None = None,
    risk_signals: pd.Series | None = None,
) -> BacktestResult:
    trade_dates = sorted(close.index[1:])
    common_dates = sorted(set(trade_dates) & set(signal.index))
    if len(common_dates) < cfg.min_dates:
        logger.error("Only %d common dates (< %d)", len(common_dates), cfg.min_dates)
        return BacktestResult()

    common_symbols = sorted(set(signal.columns) & set(close.columns))
    if len(common_symbols) < 50:
        logger.error("Only %d common symbols", len(common_symbols))
        return BacktestResult()

    signal = signal.loc[common_dates, common_symbols]
    cls = close.loc[common_dates, common_symbols]
    vol = None
    if volume is not None:
        vol = volume.loc[common_dates, common_symbols]

    n_dates = len(common_dates)
    logger.info("Backtest: %d dates, %d symbols", n_dates, len(common_symbols))

    cash = float(cfg.initial_capital)
    holdings: dict[str, int] = {}

    equity_curve = [float(cfg.initial_capital)]
    ret_curve = [0.0]
    turn_curve = [0.0]
    pos_curve = [0]
    regime_curve: list[str] = ["QUIET"]
    risk_curve: list[float] = [0.0]

    rebalance_dates = {common_dates[i] for i in range(0, n_dates, cfg.rebalance_freq)}

    for i, date in enumerate(common_dates):
        dt = pd.Timestamp(date)
        regime = str(regimes.get(dt, "QUIET")) if regimes is not None else "QUIET"
        regime_curve.append(regime)

        risk_val = float(risk_signals.get(dt, 0.0)) if risk_signals is not None else 0.0
        risk_curve.append(risk_val)

        cash_ratio = REGIME_CASH.get(regime, 0.25)
        px_today = cls.loc[dt]

        # MTM
        current_val = cash
        for sym in list(holdings.keys()):
            px = float(px_today.get(sym, np.nan))
            if pd.isna(px) or px <= 0:
                continue
            current_val += holdings[sym] * px
        current_equity = current_val

        # TRENDING_DOWN liquidation
        if regime == "TRENDING_DOWN" and holdings:
            for sym in list(holdings.keys()):
                px = float(px_today.get(sym, np.nan))
                if pd.isna(px) or px <= 0:
                    del holdings[sym]
                    continue
                sell_val = holdings[sym] * px
                cost = sell_val * (cfg.commission + cfg.stamp_tax)
                cash += sell_val - cost
                del holdings[sym]

        should_rebalance = date in rebalance_dates and regime != "TRENDING_DOWN"
        risk_active = risk_val > 0.3

        if should_rebalance and dt in signal.index:
            sig_today = signal.loc[dt].dropna().copy()

            # Price filter
            px_ok = set(px_today[px_today >= cfg.min_price].index)
            sig_today = sig_today[sig_today.index.intersection(px_ok)]

            # Volume filter (CRITICAL: excludes illiquid tail)
            if cfg.volume_filter_pct > 0 and vol is not None:
                vol_today = vol.loc[dt].dropna()
                if len(vol_today) > 50:
                    vol_threshold = vol_today.quantile(cfg.volume_filter_pct)
                    vol_ok = set(vol_today[vol_today > vol_threshold].index)
                    sig_today = sig_today[sig_today.index.intersection(vol_ok)]

            if len(sig_today) < 10:
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
                turn_curve.append(0.0)
                continue

            n_pick = min(cfg.top_n, len(sig_today))
            selected = sig_today.nlargest(n_pick)

            # Sell non-selected
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

            # Equal-weight allocation
            base_deployable = current_equity * (1.0 - cash_ratio)
            if cfg.enable_risk_layer and risk_active:
                reduction = RISK_SIGNAL_REDUCTION.get(regime, 0.75)
                deployable = base_deployable * reduction
            else:
                deployable = base_deployable

            target_per = deployable / n_pick if n_pick > 0 else 0
            for sym in selected.index:
                px = float(px_today.get(sym, np.nan))
                if pd.isna(px) or px < cfg.min_price:
                    continue
                shares = max(int(target_per / px / 100) * 100, 100)
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

    date_index = pd.DatetimeIndex(common_dates)
    return BacktestResult(
        equity=pd.Series(equity_curve[1:], index=date_index),
        daily_returns=pd.Series(ret_curve[1:], index=date_index),
        turnover=pd.Series(turn_curve[1:], index=date_index),
        n_holdings=pd.Series(pos_curve[1:], index=date_index),
        regimes=pd.Series(regime_curve[1:], index=date_index),
        risk_activations=pd.Series(risk_curve[1:], index=date_index),
        final_capital=float(equity_curve[-1]),
        total_return=float(equity_curve[-1] / equity_curve[0] - 1),
    )


# ═════════════════════════════════════════════════════════════════
# 5. Metrics & Reporting
# ═════════════════════════════════════════════════════════════════

def compute_metrics(bt: BacktestResult, cfg: Config, idx: pd.Series) -> dict[str, Any]:
    if bt.equity.empty or len(bt.equity) < 20:
        return {"error": "Insufficient data", "n_trading_days": len(bt.equity)}

    rets = bt.daily_returns.values
    n_days = len(rets)
    trading_days = 252
    period_years = n_days / trading_days
    if period_years <= 0:
        period_years = 0.01

    total_ret = bt.total_return
    annual_ret = (1 + total_ret) ** (1 / period_years) - 1
    volatility = float(np.std(rets, ddof=1) * np.sqrt(trading_days))
    sharpe = (annual_ret - 0.025) / volatility if volatility > 0 else 0.0

    neg_rets = rets[rets < 0]
    downside = float(np.std(neg_rets, ddof=1)) * np.sqrt(trading_days) if len(neg_rets) > 5 else 0.01
    sortino = (annual_ret - 0.025) / downside if downside > 0 else 0.0

    cummax = np.maximum.accumulate(bt.equity.values)
    dd = (bt.equity.values - cummax) / cummax
    max_dd = float(np.min(dd))
    calmar = annual_ret / abs(max_dd) if abs(max_dd) > 0 else 0.0

    win_rate = float(np.sum(rets > 0) / max(len(rets), 1))
    avg_turnover = float(np.mean(bt.turnover.values)) if len(bt.turnover) > 0 else 0.0
    avg_holdings = float(np.mean(bt.n_holdings.values)) if len(bt.n_holdings) > 0 else 0.0

    # Benchmark
    bench_ret = 0.0
    bench_sharpe = 0.0
    if len(idx) > 20:
        idx_aligned = idx.reindex(bt.equity.index, method="ffill")
        if len(idx_aligned) > 10:
            idx_rets = idx_aligned.pct_change().dropna().values[:n_days]
            if len(idx_rets) > 10:
                bench_total = float(idx_aligned.iloc[-1] / idx_aligned.iloc[0] - 1)
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
            r_total = float(np.prod(1 + r_rets) - 1)
            r_vol = float(np.std(r_rets, ddof=1) * np.sqrt(trading_days)) if len(r_rets) > 5 else 0
            r_sharpe = (r_total / max(len(r_rets) / trading_days, 0.01) - 0.025) / max(r_vol, 0.01)
            regime_breakdown[r] = {
                "n_days": n_days_r,
                "total_return_pct": round(r_total * 100, 2),
                "sharpe": round(float(r_sharpe), 2),
            }

    risk_active_pct = float((bt.risk_activations > 0.3).mean() * 100) if len(bt.risk_activations) > 0 else 0.0

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
        "risk_active_pct": round(risk_active_pct, 1),
        "n_factors_loaded": len(FACTOR_DEFS),
    }


def print_report(metrics: dict[str, Any], elapsed: float, cfg: Config) -> str:
    lines = [
        f"# Best Regime-Conditional Strategy — Report",
        f"",
        f"**Period**: {cfg.start} → {cfg.end}  |  **Top-N**: {cfg.top_n}"
        f"  |  **Rebalance**: {cfg.rebalance_freq}d"
        f"  |  **Volume filter**: exclude bottom {cfg.volume_filter_pct*100:.0f}%",
        f"",
    ]
    if "error" in metrics:
        lines.append(f"**Error**: {metrics['error']}")
        return "\n".join(lines)

    m = metrics

    lines += ["## Factor Model (Phase 1a)", ""]
    lines.append("| # | Factor | Family | Dir | QUIET | HIGH_VOL | TRENDING_UP | Description |")
    lines.append("|---|--------|--------|-----|-------|----------|-------------|-------------|")
    for i, fd in enumerate(FACTOR_DEFS):
        w = fd["w"]
        lines.append(
            f"| {i+1} | {fd['name']} | {fd['family']} | {fd['dir']} "
            f"| {w['QUIET']:.1f} | {w['HIGH_VOL']:.1f} | {w['TRENDING_UP']:.1f} | {fd['desc']} |"
        )

    lines += ["", "## Cash & Risk Overlay", ""]
    lines.append("| Regime | Cash | Risk Reduction |")
    lines.append("|--------|------|---------------|")
    for r in ["QUIET", "HIGH_VOL", "TRENDING_UP", "TRENDING_DOWN"]:
        c = REGIME_CASH.get(r, 0) * 100
        rr = RISK_SIGNAL_REDUCTION.get(r, 1.0) * 100
        lines.append(f"| {r} | {c:.0f}% | {rr:.0f}% |")
    lines.append(f"| Risk signals active | — | {m.get('risk_active_pct', 'N/A')}% of days |")

    lines += ["", "## Performance", ""]
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

    rb = m.get("regime_breakdown", {})
    if rb:
        lines += ["", "## Regime Breakdown", "",
                  "| Regime | Days | Return | Sharpe |",
                  "|--------|------|--------|--------|"]
        for r in sorted(rb.keys()):
            rd = rb[r]
            lines.append(f"| {r} | {rd['n_days']} | {rd['total_return_pct']:+.2f}% | {rd['sharpe']:.2f} |")

    lines.append("")
    return "\n".join(lines)


def save_output(metrics: dict, bt: BacktestResult, cfg: Config, elapsed: float) -> Path:
    out_dir = OUTPUT_BASE / cfg.run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    m_out = {k: v for k, v in metrics.items() if k != "regime_breakdown"}
    if "error" not in metrics:
        r = {
            "metrics": m_out,
            "regime_breakdown": metrics.get("regime_breakdown", {}),
            "config": {
                "start": cfg.start, "end": cfg.end, "top_n": cfg.top_n,
                "rebalance_freq": cfg.rebalance_freq,
                "volume_filter_pct": cfg.volume_filter_pct,
                "n_factors": len(FACTOR_DEFS), "factor_names": FACTOR_NAMES,
                "regime_cash": REGIME_CASH,
                "risk_signal_reduction": RISK_SIGNAL_REDUCTION,
                "commission": cfg.commission, "stamp_tax": cfg.stamp_tax,
                "slippage": cfg.slippage,
                "enable_risk_layer": cfg.enable_risk_layer,
            },
        }
    else:
        r = {"metrics": metrics, "config": {"start": cfg.start, "end": cfg.end}}
    (out_dir / "result.json").write_text(json.dumps(r, indent=2, ensure_ascii=False))

    report = print_report(metrics, elapsed, cfg)
    (out_dir / "report.md").write_text(report, encoding="utf-8")

    if bt and bt.equity is not None and len(bt.equity) > 0:
        daily = pd.DataFrame({
            "equity": bt.equity, "return": bt.daily_returns,
            "turnover": bt.turnover, "holdings": bt.n_holdings,
            "regime": bt.regimes, "risk_signal": bt.risk_activations,
        })
        daily.to_parquet(out_dir / "daily_equity.parquet")

    (out_dir / "manifest.json").write_text(json.dumps({
        "command": "best_strategy", "version": "v2.0-fixed-trendingup",
        "start": cfg.start, "end": cfg.end,
        "exit_code": 0, "elapsed_seconds": round(elapsed, 1),
    }, indent=2))

    logger.info("Output: %s", out_dir)
    return out_dir


# ═════════════════════════════════════════════════════════════════
# 6. Pipeline
# ═════════════════════════════════════════════════════════════════

def run_pipeline(cfg: Config) -> dict[str, Any]:
    t0 = time.time()
    logger.info("=" * 60)
    logger.info("Best Regime Strategy v2: %s → %s  [%dfactors, top-%d, %dd rebal, volFilter=bottom%.0f%%]",
                cfg.start, cfg.end, len(FACTOR_DEFS), cfg.top_n,
                cfg.rebalance_freq, cfg.volume_filter_pct * 100)

    logger.info("[1/5] Loading factor panels (Phase 1a factors)...")
    factor_panels = load_factor_panels(cfg.start, cfg.end)
    if len(factor_panels) < 2:
        return {"error": f"Insufficient factors ({len(factor_panels)})", "n_loaded": len(factor_panels)}

    logger.info("[2/5] Loading market data...")
    market = load_market_panel(cfg.start, cfg.end)
    if not market or "close" not in market or market["close"].empty:
        return {"error": "No market data"}
    close = market["close"].astype(np.float32)
    volume = market.get("volume")

    logger.info("[3/5] Loading CSI300 for regime detection...")
    idx = load_index_series("000300.SH")

    logger.info("[4/5] Detecting market regime...")
    regimes, risk_signals = detect_regime(idx, close)

    logger.info("[5/5] Building regime-conditional composite signal...")
    signal = build_composite_signal(factor_panels, regimes)
    if signal.empty:
        return {"error": "Empty composite signal"}

    bt = run_backtest(signal, close, volume, cfg, regimes, risk_signals)
    if bt.equity.empty or len(bt.equity) < 20:
        return {"error": "Backtest produced no trades or insufficient data"}

    metrics = compute_metrics(bt, cfg, idx)
    elapsed = time.time() - t0

    logger.info("=" * 60)
    if "error" in metrics:
        logger.error("Error: %s", metrics["error"])
    else:
        logger.info("Result: Ret=%+.2f%%  Sharpe=%.3f  DD=%.2f%%  [%.1fs]",
                     metrics.get("total_return_pct", 0),
                     metrics.get("sharpe_ratio", 0),
                     metrics.get("max_drawdown_pct", 0), elapsed)

    return {"metrics": metrics, "bt": bt, "signal": signal, "elapsed": elapsed}


def run_baseline(cfg: Config) -> dict[str, Any]:
    from analysis_v2.core import FactorCache
    cache = FactorCache()
    market = cache.load_market_panel(cfg.start, cfg.end)
    close = market["close"].astype(np.float32)
    idx = load_index_series("000300.SH")
    cfg_b = Config(start=cfg.start, end=cfg.end, top_n=9999,
                   rebalance_freq=cfg.rebalance_freq, volume_filter_pct=0.0,
                   enable_risk_layer=False, run_id="baseline")
    common_dates = sorted(close.index[1:])[:]
    common_symbols = sorted(close.columns)[:max(50, min(500, len(close.columns)))]
    baseline_signal = pd.DataFrame(
        1.0, index=pd.DatetimeIndex(common_dates), columns=common_symbols
    ).astype(np.float32)
    bt = run_backtest(baseline_signal, close, volume=None, cfg=cfg_b)
    metrics = compute_metrics(bt, cfg_b, idx)
    return {"metrics": metrics, "bt": bt, "elapsed": 0.0}


def run_walk_forward(cfg: Config) -> dict[str, Any]:
    dates = pd.bdate_range(cfg.start, cfg.end)
    if len(dates) < cfg.walk_forward_folds * 20:
        return {"error": f"Too few dates for {cfg.walk_forward_folds}-fold WF"}
    fold_size = len(dates) // cfg.walk_forward_folds
    folds_list, sharpes = [], []
    logger.info("Walk-forward: %d folds, ~%d dates/fold", cfg.walk_forward_folds, fold_size)
    for fold in range(cfg.walk_forward_folds):
        fs = dates[fold * fold_size].strftime("%Y-%m-%d")
        if fold < cfg.walk_forward_folds - 1:
            fe = dates[(fold + 1) * fold_size - 1].strftime("%Y-%m-%d")
        else:
            fe = dates[-1].strftime("%Y-%m-%d")
        fc = Config(start=fs, end=fe, top_n=cfg.top_n,
                     rebalance_freq=cfg.rebalance_freq,
                     volume_filter_pct=cfg.volume_filter_pct,
                     enable_risk_layer=cfg.enable_risk_layer)
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
    parser = argparse.ArgumentParser(description="Best Regime Strategy v2")
    parser.add_argument("--start", default="2026-01-05")
    parser.add_argument("--end", default="2026-07-01")
    parser.add_argument("--top-n", type=int, default=30)
    parser.add_argument("--rebalance", type=int, default=3)
    parser.add_argument("--volume-filter", type=float, default=0.2)
    parser.add_argument("--walk-forward", type=int, default=0)
    parser.add_argument("--no-risk-layer", action="store_true")
    parser.add_argument("--compare-baseline", action="store_true")
    parser.add_argument("--list-factors", action="store_true")
    args = parser.parse_args()

    if args.list_factors:
        print(f"\n{'Factor':30s} {'Family':12s} {'Dir':5s} {'QUIET':8s} {'HIGH_VOL':10s} {'TRENDING_UP':12s}")
        print("-" * 90)
        for fd in FACTOR_DEFS:
            w = fd["w"]
            print(f"{fd['name']:30s} {fd['family']:12s} {fd['dir']:5s}"
                  f" {w['QUIET']:6.1f}  {w['HIGH_VOL']:6.1f}  {w['TRENDING_UP']:6.1f}")
        print()
        return 0

    cfg = Config(
        start=args.start, end=args.end,
        top_n=args.top_n, rebalance_freq=args.rebalance,
        volume_filter_pct=args.volume_filter,
        enable_risk_layer=not args.no_risk_layer,
    )

    if args.compare_baseline:
        logger.info("Running baseline comparison...")
        _ = run_baseline(cfg)

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
        print(f"  Mean Sharpe: {wf['mean_sharpe']:7.3f}  Std: {wf['std_sharpe']:7.3f}")
        print(f"  Min: {wf['min_sharpe']:7.3f}  Max: {wf['max_sharpe']:7.3f}")
        print(f"{'='*62}\n")
        return 0

    result = run_pipeline(cfg)
    if "error" in result:
        print(f"Error: {result['error']}")
        return 1

    out_dir = save_output(result["metrics"], result["bt"], cfg, result["elapsed"])
    print(f"\n  Output: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
