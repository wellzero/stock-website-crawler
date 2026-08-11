#!/usr/bin/env python3
"""
Robust Multi-Factor Strategy (Best Implementation)
==================================================

Based on systematic analysis of analysis_v2 infrastructure.

Key findings leveraged:
  1. Volume filter (exclude bottom 20%) is the single largest improvement
     — previous agents found ~+18% swing from this alone
  2. Highest-coverage factors (94% across 18mo) are all quality/defense:
     defense_profitability, dim_quality, liquidity_amihud,
     defense_accrual_proxy, flow_net_mom_20
  3. Simple equal-weight outperforms signal-weight in out-of-sample
  4. CSI300 momentum trend filter provides effective risk management

Architecture:
  Layer 1: Data — factor cache + market panel + CSI300 index
  Layer 2: Signal — equal-weight multi-factor composite
  Layer 3: Risk — CSI300 trend filter + volatility-based cash management

Usage:
  uv run python3 scripts/robust_strategy.py                    # Full 18mo backtest
  uv run python3 scripts/robust_strategy.py --start 2026-01-05 # 2026 H1 only
  uv run python3 scripts/robust_strategy.py --walk-forward 5   # 5-fold cross-validation
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

OUTPUT_BASE = Path("/Users/fengzhi/Downloads/git/testlixingren/output/robust_strategy")

# ───────────────────────────────────────────────────────────────
# Factor Definitions — simple equal-weight composite
# All have >90% coverage on 2025-01 to 2026-07
# ───────────────────────────────────────────────────────────────

FACTOR_DEFS: list[dict[str, Any]] = [
    {
        "name": "defense_profitability",
        "dir": "pos",
        "family": "Quality",
        "weight": 1.0,
        "desc": "Operating profitability (cfo_to_ev proxy) — 94% coverage",
    },
    {
        "name": "dim_quality",
        "dir": "pos",
        "family": "Quality",
        "weight": 1.0,
        "desc": "Comprehensive quality score — 94% coverage",
    },
    {
        "name": "liquidity_amihud",
        "dir": "neg",
        "family": "Liquidity",
        "weight": 1.0,
        "desc": "Amihud illiquidity measure (lower = more liquid) — 94% coverage",
    },
    {
        "name": "defense_accrual_proxy",
        "dir": "neg",
        "family": "Defensive",
        "weight": 1.0,
        "desc": "Accrual-based defense proxy (lower = less manipulation) — 94% coverage",
    },
    {
        "name": "flow_net_mom_20",
        "dir": "pos",
        "family": "Flow",
        "weight": 1.0,
        "desc": "Net money flow momentum (20-day) — 94% coverage",
    },
]

FACTOR_NAMES = [d["name"] for d in FACTOR_DEFS]
FACTOR_WEIGHTS = {d["name"]: d["weight"] for d in FACTOR_DEFS}
FACTOR_DIRS = {d["name"]: d["dir"] for d in FACTOR_DEFS}


@dataclass
class Config:
    start: str = "2025-01-01"
    end: str = "2026-07-01"
    top_n: int = 30
    rebalance_freq: int = 5
    initial_capital: float = 1_000_000.0
    min_price: float = 2.0
    min_stock_days: int = 30
    commission: float = 0.0002
    stamp_tax: float = 0.001
    slippage: float = 0.0008
    # Volume filter: exclude bottom N% by median volume
    volume_filter_pct: float = 0.20
    # Trend filter: go to cash when CSI300 drops below this threshold
    trend_filter_lookback: int = 20
    trend_filter_entry: float = -0.05   # 5% decline → reduce to cash
    trend_filter_exit: float = 0.0      # recover to entry → re-enter
    # Cash during high vol
    vol_cash_threshold: float = 0.40   # annualized vol > 40% → reduce equity
    vol_cash_ratio: float = 0.50       # reduce to 50% equity when vol high
    # Risk overlay
    enable_risk_layer: bool = True
    walk_forward_folds: int = 0
    run_id: str = field(default_factory=lambda: datetime.now().strftime("robust_%Y%m%d_%H%M%S_%f")[:24])


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
    from analysis_v2.core import FactorCache
    cache = FactorCache()
    records: list[pd.Series] = []
    idx_dir = AV2_ROOT / "data_cache" / "market_data" / "daily" / "index_daily"
    if not idx_dir.exists():
        logger.warning("Index dir not found: %s", idx_dir)
        return pd.Series(dtype=np.float32)
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
        logger.warning("No index data found for %s", idx_code)
        return pd.Series(dtype=np.float32)
    s = pd.concat(records).sort_index().astype(np.float32).dropna()
    logger.info("Index %s: %d days", idx_code, len(s))
    return s


# ═════════════════════════════════════════════════════════════════
# 2. Signal Construction — equal-weight composite
# ═════════════════════════════════════════════════════════════════

def cross_sectional_rank(panel: pd.DataFrame, direction: str = "pos") -> pd.DataFrame:
    """Cross-sectional percentile rank, scaled to [-1, 1]."""
    r = panel.rank(axis=1, pct=True, na_option="keep")
    scaled = (r - 0.5) * 2.0
    if direction == "neg":
        scaled = -scaled
    return scaled


def build_composite_signal(
    factor_panels: dict[str, pd.DataFrame],
) -> pd.DataFrame:
    """Build equal-weight multi-factor composite signal."""
    normed: dict[str, pd.DataFrame] = {}
    for name, panel in factor_panels.items():
        fd_dir = FACTOR_DIRS.get(name, "pos")
        n = cross_sectional_rank(panel, fd_dir)
        n = n.fillna(0.0)
        normed[name] = n

    if not normed:
        return pd.DataFrame(dtype=np.float32)

    # Weighted sum across all factors
    composite = None
    total_weight = 0.0
    for name in FACTOR_NAMES:
        if name not in normed:
            continue
        w = FACTOR_WEIGHTS.get(name, 1.0)
        if composite is None:
            composite = normed[name] * w
        else:
            # Align indices
            idx = sorted(set(composite.index) & set(normed[name].index))
            cols = sorted(set(composite.columns) & set(normed[name].columns))
            composite = composite.loc[idx, cols] + normed[name].loc[idx, cols] * w
        total_weight += w

    if composite is None or total_weight <= 0:
        return pd.DataFrame(dtype=np.float32)

    composite = (composite / total_weight).astype(np.float32)
    logger.info("Signal: %d dates × %d stocks", *composite.shape)
    return composite


# ═════════════════════════════════════════════════════════════════
# 3. Risk Management
# ═════════════════════════════════════════════════════════════════

def compute_risk_state(
    idx_close: pd.Series,
    close_panel: pd.DataFrame,
    cfg: Config,
) -> pd.Series:
    """
    Compute daily risk state (equity fraction to maintain).

    Returns a Series of equity allocation ratios [0.0, 1.0]
    for each trading day.
    """
    # CSI300 trend filter
    idx_rets = idx_close.pct_change(cfg.trend_filter_lookback).dropna()
    trend_mask = idx_rets <= cfg.trend_filter_entry
    
    # Volatility filter
    rets = close_panel.pct_change().dropna(how="all")
    ew_rets = rets.mean(axis=1).dropna()
    ann_vol = (ew_rets.rolling(20, min_periods=10).std() * np.sqrt(252)).dropna()
    vol_mask = ann_vol >= cfg.vol_cash_threshold
    
    # Combine: take min of both signals
    all_dates = sorted(set(trend_mask.index) | set(vol_mask.index))
    equity_frac = pd.Series(1.0, index=pd.DatetimeIndex(all_dates))
    
    for dt in all_dates:
        dt_ts = pd.Timestamp(dt)
        if dt_ts in trend_mask.index and trend_mask.loc[dt_ts]:
            equity_frac.loc[dt_ts] = 0.0  # Full cash
        elif dt_ts in vol_mask.index and vol_mask.loc[dt_ts]:
            equity_frac.loc[dt_ts] = 1.0 - cfg.vol_cash_ratio  # Partial cash
    
    n_active = int((equity_frac < 1.0).sum())
    logger.info("Risk overlay: %.1f%% days reduced equity (%d events)",
                n_active / len(equity_frac) * 100, n_active)
    return equity_frac


# ═════════════════════════════════════════════════════════════════
# 4. Backtest Engine
# ═════════════════════════════════════════════════════════════════

@dataclass
class BacktestResult:
    equity: pd.Series = field(default_factory=pd.Series)
    daily_returns: pd.Series = field(default_factory=pd.Series)
    turnover: pd.Series = field(default_factory=pd.Series)
    n_holdings: pd.Series = field(default_factory=pd.Series)
    equity_frac: pd.Series = field(default_factory=pd.Series)
    final_capital: float = 0.0
    total_return: float = 0.0


def run_backtest(
    signal: pd.DataFrame,
    close: pd.DataFrame,
    volume: pd.DataFrame | None,
    equity_frac: pd.Series | None,
    cfg: Config,
) -> BacktestResult:
    # Align dates
    trade_dates = sorted(close.index[1:])
    common_dates = sorted(set(trade_dates) & set(signal.index))
    if len(common_dates) < cfg.min_stock_days:
        logger.error("Only %d common dates (< %d)", len(common_dates), cfg.min_stock_days)
        return BacktestResult()

    common_symbols = sorted(set(signal.columns) & set(close.columns))
    if len(common_symbols) < 50:
        logger.error("Only %d common symbols", len(common_symbols))
        return BacktestResult()

    signal = signal.loc[common_dates, common_symbols]
    close_p = close.loc[common_dates, common_symbols]
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
    ef_curve = [1.0]

    rebalance_dates = {common_dates[i] for i in range(0, n_dates, cfg.rebalance_freq)}

    for i, date in enumerate(common_dates):
        dt = pd.Timestamp(date)
        px_today = close_p.loc[dt]

        # MTM
        current_val = cash
        for sym in list(holdings.keys()):
            px = float(px_today.get(sym, np.nan))
            if pd.isna(px) or px <= 0:
                continue
            current_val += holdings[sym] * px
        current_equity = current_val

        # Risk state
        ef = float(equity_frac.get(dt, 1.0)) if equity_frac is not None else 1.0
        ef_curve.append(ef)

        # Liquidate if full cash
        if ef <= 0.001 and holdings:
            for sym in list(holdings.keys()):
                px = float(px_today.get(sym, np.nan))
                if pd.isna(px) or px <= 0:
                    del holdings[sym]
                    continue
                sell_val = holdings[sym] * px
                cost = sell_val * (cfg.commission + cfg.stamp_tax)
                cash += sell_val - cost
                del holdings[sym]

        # Rebalance
        should_rebalance = date in rebalance_dates and ef > 0.001

        if should_rebalance and dt in signal.index:
            sig_today = signal.loc[dt].dropna().copy()

            # Price filter
            px_ok = set(px_today[px_today >= cfg.min_price].index)
            sig_today = sig_today[sig_today.index.intersection(px_ok)]

            # Volume filter (CRITICAL)
            if cfg.volume_filter_pct > 0 and vol is not None:
                vol_today = vol.loc[dt].dropna()
                if len(vol_today) > 50:
                    vol_threshold = vol_today.quantile(cfg.volume_filter_pct)
                    vol_ok = set(vol_today[vol_today > vol_threshold].index)
                    sig_today = sig_today[sig_today.index.intersection(vol_ok)]

            if len(sig_today) < 10:
                # Skip rebalance
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

            # Pick top N by composite score
            sig_sorted = sig_today.sort_values(ascending=False)
            n_pick = min(cfg.top_n, len(sig_sorted))
            selected = sig_sorted.iloc[:n_pick]

            # Sell positions not in new portfolio
            total_turnover = 0.0
            new_symbols = set(selected.index)
            for sym in list(holdings.keys()):
                if sym in new_symbols:
                    continue
                px = float(px_today.get(sym, np.nan))
                if pd.isna(px) or px <= 0:
                    holdings.pop(sym, None)
                    continue
                sell_val = holdings[sym] * px
                cost = sell_val * (cfg.commission + cfg.stamp_tax)
                cash += sell_val - cost
                total_turnover += sell_val
                holdings.pop(sym, None)

            # Equal-weight buy
            deployable = current_equity * ef
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

            turn_curve.append(total_turnover / max(current_equity, 1))
        else:
            turn_curve.append(0.0)

        # Final MTM
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
        equity_frac=pd.Series(ef_curve[1:], index=date_index),
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
    avg_ef = float(np.mean(bt.equity_frac.values)) if len(bt.equity_frac) > 0 else 1.0

    # Equally-weighted benchmark (all stocks)
    from analysis_v2.core import FactorCache
    cache = FactorCache()
    try:
        mkt = cache.load_market_panel(cfg.start, cfg.end)
        close_bm = mkt["close"]
        rets_bm = close_bm.pct_change().dropna(how="all")
        ew_bm = rets_bm.mean(axis=1).dropna()
        ew_aligned = ew_bm.reindex(bt.equity.index, method="ffill").dropna()
        ew_total = float((1 + ew_aligned).prod() - 1) if len(ew_aligned) > 0 else 0.0
        ew_ann = float((1 + ew_total) ** (1 / period_years) - 1) if period_years > 0 else 0.0
        ew_vol = float(ew_aligned.std() * np.sqrt(trading_days)) if len(ew_aligned) > 5 else 0.0
        ew_sharpe = float((ew_ann - 0.025) / ew_vol) if ew_vol > 0 else 0.0
    except Exception:
        ew_total = ew_ann = ew_sharpe = 0.0

    # CSI300 benchmark
    if len(idx) > 20:
        idx_aligned = idx.reindex(bt.equity.index, method="ffill").dropna()
        if len(idx_aligned) > 10:
            cs_total = float(idx_aligned.iloc[-1] / idx_aligned.iloc[0] - 1)
            idx_rets = idx_aligned.pct_change().dropna().values[:n_days]
            cs_ann = float((1 + cs_total) ** (1 / period_years) - 1) if period_years > 0 else 0.0
            cs_vol = float(np.std(idx_rets, ddof=1) * np.sqrt(trading_days)) if len(idx_rets) > 5 else 0.0
            cs_sharpe = float((cs_ann - 0.025) / cs_vol) if cs_vol > 0 else 0.0
        else:
            cs_total = cs_ann = cs_sharpe = 0.0
    else:
        cs_total = cs_ann = cs_sharpe = 0.0

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
        "avg_equity_exposure_pct": round(avg_ef * 100, 1),
        "n_trading_days": n_days,
        "period_years": round(period_years, 2),
        "final_capital": round(bt.final_capital, 2),
        # Benchmarks
        "ew_benchmark_return_pct": round(ew_total * 100, 2),
        "ew_benchmark_sharpe": round(ew_sharpe, 3),
        "cs_benchmark_return_pct": round(cs_total * 100, 2),
        "cs_benchmark_sharpe": round(cs_sharpe, 3),
        "excess_vs_ew_pct": round((total_ret - ew_total) * 100, 2),
        "excess_vs_cs_pct": round((total_ret - cs_total) * 100, 2),
        "n_factors": len(FACTOR_DEFS),
        "factors": FACTOR_NAMES,
    }


def print_report(metrics: dict[str, Any], elapsed: float, cfg: Config) -> str:
    lines = [
        f"# Robust Multi-Factor Strategy — Report",
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

    lines += ["## Factor Model", ""]
    lines.append("| # | Factor | Family | Dir | Weight | Coverage |")
    lines.append("|---|--------|--------|-----|--------|----------|")
    for i, fd in enumerate(FACTOR_DEFS):
        lines.append(
            f"| {i+1} | {fd['name']} | {fd['family']} | {fd['dir']} "
            f"| {fd['weight']:.1f} | {fd['desc']} |"
        )

    lines += ["", "## Risk Management", ""]
    lines += [
        f"| Parameter | Value |",
        f"|-----------|-------|",
        f"| Trend filter lookback | {cfg.trend_filter_lookback}d |",
        f"| Trend filter entry | {cfg.trend_filter_entry*100:.0f}% decline → full cash |",
        f"| Trend filter exit | {cfg.trend_filter_exit*100:.0f}% recovery → re-enter |",
        f"| Vol cash trigger | {cfg.vol_cash_threshold*100:.0f}% annualized vol |",
        f"| Vol cash ratio | {cfg.vol_cash_ratio*100:.0f}% equity when vol high |",
        f"| Avg equity exposure | {m.get('avg_equity_exposure_pct', 'N/A')}% |",
    ]

    lines += ["", "## Performance", ""]
    lines += [
        f"| Metric | Strategy | EW Benchmark | CSI300 |",
        f"|--------|----------|--------------|--------|",
        f"| Total Return | {m.get('total_return_pct', 0):+.2f}% | {m.get('ew_benchmark_return_pct', 0):+.2f}% | {m.get('cs_benchmark_return_pct', 0):+.2f}% |",
        f"| Annual Return | {m.get('annual_return_pct', 0):+.2f}% | — | — |",
        f"| Sharpe | {m.get('sharpe_ratio', 0):.3f} | {m.get('ew_benchmark_sharpe', 0):.3f} | {m.get('cs_benchmark_sharpe', 0):.3f} |",
        f"| Sortino | {m.get('sortino_ratio', 0):.3f} | — | — |",
        f"| Calmar | {m.get('calmar_ratio', 0):.3f} | — | — |",
        f"| Max DD | {m.get('max_drawdown_pct', 0):.2f}% | — | — |",
        f"| Volatility | {m.get('volatility_pct', 0):.2f}% | — | — |",
        f"| Win Rate | {m.get('win_rate_pct', 0):.1f}% | — | — |",
        f"| Turnover | {m.get('avg_turnover_pct', 0):.2f}% | — | — |",
        f"| Avg Holdings | {m.get('avg_holdings', 0):.0f} | — | — |",
        f"| Final Capital | ¥{m.get('final_capital', 0):,.0f} | — | — |",
        f"| Trading Days | {m.get('n_trading_days', 0):d} | — | — |",
    ]

    lines += ["", "## Excess Returns", ""]
    exc_ew = m.get('excess_vs_ew_pct', 0)
    exc_cs = m.get('excess_vs_cs_pct', 0)
    if exc_ew > 0:
        lines.append(f"✅ **Beat equal-weight benchmark by {exc_ew:+.2f}%**")
    else:
        lines.append(f"❌ **Underperformed equal-weight by {exc_ew:+.2f}%**")
    if exc_cs > 0:
        lines.append(f"✅ **Beat CSI300 by {exc_cs:+.2f}%**")
    else:
        lines.append(f"❌ **Underperformed CSI300 by {exc_cs:+.2f}%**")

    lines.append("")
    return "\n".join(lines)


def save_output(metrics: dict, bt: BacktestResult, cfg: Config, elapsed: float) -> Path:
    out_dir = OUTPUT_BASE / cfg.run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    r = {
        "metrics": metrics,
        "config": {
            "start": cfg.start, "end": cfg.end, "top_n": cfg.top_n,
            "rebalance_freq": cfg.rebalance_freq,
            "volume_filter_pct": cfg.volume_filter_pct,
            "n_factors": len(FACTOR_DEFS), "factor_names": FACTOR_NAMES,
            "commission": cfg.commission, "stamp_tax": cfg.stamp_tax,
            "slippage": cfg.slippage,
            "enable_risk_layer": cfg.enable_risk_layer,
            "trend_filter_lookback": cfg.trend_filter_lookback,
            "trend_filter_entry": cfg.trend_filter_entry,
            "vol_cash_threshold": cfg.vol_cash_threshold,
        },
    }
    (out_dir / "result.json").write_text(json.dumps(r, indent=2, ensure_ascii=False))

    report = print_report(metrics, elapsed, cfg)
    (out_dir / "report.md").write_text(report, encoding="utf-8")

    if bt and bt.equity is not None and len(bt.equity) > 0:
        daily = pd.DataFrame({
            "equity": bt.equity, "return": bt.daily_returns,
            "turnover": bt.turnover, "holdings": bt.n_holdings,
            "equity_frac": bt.equity_frac,
        })
        daily.to_parquet(out_dir / "daily_equity.parquet")

    (out_dir / "manifest.json").write_text(json.dumps({
        "command": "robust_strategy", "version": "v1.0",
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
    logger.info("Robust Strategy: %s → %s  [%d factors, top-%d, %dd rebal, volFilter=%d%%]",
                cfg.start, cfg.end, len(FACTOR_DEFS), cfg.top_n,
                cfg.rebalance_freq, int(cfg.volume_filter_pct * 100))

    logger.info("[1/4] Loading factors...")
    factor_panels = load_factor_panels(cfg.start, cfg.end)
    if len(factor_panels) < 2:
        return {"error": f"Insufficient factors ({len(factor_panels)})"}

    logger.info("[2/4] Loading market data...")
    market = load_market_panel(cfg.start, cfg.end)
    if not market or "close" not in market or market["close"].empty:
        return {"error": "No market data"}
    close = market["close"].astype(np.float32)
    volume = market.get("volume")

    logger.info("[3/4] Computing risk state...")
    idx = load_index_series("000300.SH")
    equity_frac = compute_risk_state(idx, close, cfg) if cfg.enable_risk_layer else None

    logger.info("[4/4] Building signal + backtest...")
    signal = build_composite_signal(factor_panels)
    if signal.empty:
        return {"error": "Empty composite signal"}

    bt = run_backtest(signal, close, volume, equity_frac, cfg)
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


def run_walk_forward(cfg: Config) -> dict[str, Any]:
    dates = pd.bdate_range(cfg.start, cfg.end)
    if len(dates) < cfg.walk_forward_folds * 20:
        return {"error": f"Too few dates for {cfg.walk_forward_folds}-fold WF"}
    fold_size = len(dates) // cfg.walk_forward_folds
    folds_list, sharpes = [], []
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
            if result and "metrics" in result and "error" not in result["metrics"]:
                m = result["metrics"]
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
    parser = argparse.ArgumentParser(description="Robust Multi-Factor Strategy")
    parser.add_argument("--start", default="2025-01-01")
    parser.add_argument("--end", default="2026-07-01")
    parser.add_argument("--top-n", type=int, default=30)
    parser.add_argument("--rebalance", type=int, default=5)
    parser.add_argument("--volume-filter", type=float, default=0.20)
    parser.add_argument("--no-risk-layer", action="store_true")
    parser.add_argument("--walk-forward", type=int, default=0)
    parser.add_argument("--list-factors", action="store_true")
    args = parser.parse_args()

    if args.list_factors:
        print(f"\n{'Factor':30s} {'Family':15s} {'Dir':5s} {'Weight':8s}")
        print("-" * 60)
        for fd in FACTOR_DEFS:
            print(f"{fd['name']:30s} {fd['family']:15s} {fd['dir']:5s} {fd['weight']:5.1f}")
        print()
        return 0

    cfg = Config(
        start=args.start, end=args.end,
        top_n=args.top_n, rebalance_freq=args.rebalance,
        volume_filter_pct=args.volume_filter,
        enable_risk_layer=not args.no_risk_layer,
    )

    result = run_pipeline(cfg)
    if "error" in result:
        print(f"Error: {result['error']}")
        return 1

    out_dir = save_output(result["metrics"], result["bt"], cfg, result["elapsed"])
    print(f"\n  Output: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
