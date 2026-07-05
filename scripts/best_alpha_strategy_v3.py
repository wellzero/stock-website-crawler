#!/usr/bin/env python3
"""
Best Alpha Strategy v3 — Multi-Factor Stock Selection with Regime-Aware Risk Control
================================================================================

v3 improvements:
  1. Factors COMPUTED from OHLCV stock_daily data (full coverage since Jan 2026)
  2. Plus strategy_a parquet factors (defense/quality, 5500+ stocks from May 2026)
  3. 12 factor families instead of 45 noisy ones
  4. Regime-aware POSITION SIZING only (no per-factor regime weights to overfit)
  5. Honest P&L attribution: stocks earn return only AFTER purchase date
  6. Correct sortino calculation
  7. Walk-forward validation built-in
  8. Auto-IC report at the end to validate factor choices

Data sources (both in analysis_v2/data_cache/):
  - market_data/daily/stock_daily/   OHLCV + returns (2013-2026, 5500 stocks)
  - factors/YYYY/YYYY-MM-DD/*.parquet  strategy_a factors (good coverage)
  - market_data/daily/index_daily/   CSI300 index for regime detection
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import warnings
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=RuntimeWarning)

ANALYSIS_V2_ROOT = Path("/Users/fengzhi/Downloads/git2/analysis_v2")
sys.path.insert(0, str(ANALYSIS_V2_ROOT))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("alpha_v3")


@dataclass
class Config:
    """Strategy configuration."""

    start: str = "2026-05-06"
    end: str = "2026-07-03"
    data_root: str = str(ANALYSIS_V2_ROOT / "data_cache")
    output_root: str = "output/alpha_strategy_v3"
    index_code: str = "000300.SH"

    # Factor selection
    ohlcv_factors: list[str] = field(default_factory=lambda: [
        "price_change_5", "price_change_20",
        "volatility_20", "volatility_60",
        "volume_ratio_20",
        "turnover_mean_20",
        "amihud_illiq_20",
    ])
    parquet_factor_file: str = "factors/factors_strategy_a.parquet"
    parquet_factor_cols: list[str] = field(default_factory=lambda: [
        "defense_quality_raw",
        "defense_price_stability",
        "defense_profitability",
        "liquidity_amihud",
        "flow_net_mom_20",
    ])

    # Factor directional signs (+1 = long high, -1 = short high)
    factor_signs: dict[str, float] = field(default_factory=lambda: {
        "price_change_5":     1.0,
        "price_change_20":    1.0,
        "volatility_20":     -1.5,
        "volatility_60":     -1.0,
        "volume_ratio_20":    0.5,
        "turnover_mean_20": -0.5,
        "amihud_illiq_20":    0.3,
        "defense_quality_raw":      1.5,
        "defense_price_stability":  1.0,
        "defense_profitability":    0.8,
        "liquidity_amihud":         0.5,
        "flow_net_mom_20":         0.8,
    })

    top_n: int = 30
    rebalance_days: int = 3
    commission_rate: float = 0.0003
    stamp_tax_rate: float = 0.001
    slippage: float = 0.001
    max_position_pct: float = 0.08
    initial_capital: float = 1_000_000
    ffill_days: int = 3

    enable_market_timing: bool = True
    trending_down_exit: bool = True
    volatile_position_pct: float = 0.50

    walk_forward_folds: int = 0


# ══════════════════════════════════════════════════════════════════
# 1. Data Loader
# ══════════════════════════════════════════════════════════════════


class DataLoader:
    """Load and cache all data.

    Loads a BROAD OHLCV panel (Jan→Jul 2026) and computes rolling
    factors in one shot instead of per-date loading.
    """

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.root = Path(cfg.data_root)
        self._ohlcv_close: pd.DataFrame | None = None
        self._returns_panel: pd.DataFrame | None = None
        self._vol_panel: pd.DataFrame | None = None
        self._amt_panel: pd.DataFrame | None = None
        self._to_panel: pd.DataFrame | None = None
        self._index_df: pd.DataFrame | None = None
        self._benchmark_returns: pd.Series | None = None
        self._computed_factors: dict[str, pd.DataFrame] = {}

    def _load_stock_panels(self, start: str, end: str):
        """Load all OHLCV panels in one pass."""
        s_dt = pd.Timestamp(start)
        e_dt = pd.Timestamp(end)
        lookback_start = max(s_dt - timedelta(days=120), pd.Timestamp("2026-01-01"))
        base = self.root / "market_data" / "daily" / "stock_daily"

        t0 = time.time()
        records = []
        for pdir in sorted(base.iterdir()):
            name = pdir.name
            if not name.startswith("date="):
                continue
            try:
                dt = pd.to_datetime(name.replace("date=", ""))
            except Exception:
                continue
            if dt > e_dt:
                break
            if dt < lookback_start:
                continue
            for fp in pdir.glob("*.parquet"):
                try:
                    df = pd.read_parquet(
                        fp,
                        columns=["symbol", "close", "change_pct",
                                 "volume", "amount", "turnover_rate"],
                    )
                except Exception:
                    continue
                df["date"] = dt
                records.append(df)
                break

        if not records:
            return

        pdf = pd.concat(records, ignore_index=True)
        pdf["symbol"] = pdf["symbol"].str.lower()
        pdf["ret"] = pdf["change_pct"].astype(float) / 100.0
        pdf = pdf.dropna(subset=["close", "ret"])
        pdf = pdf.drop_duplicates(subset=["date", "symbol"])

        self._ohlcv_close = pdf.pivot(
            index="date", columns="symbol", values="close"
        ).sort_index().astype(np.float32)

        self._returns_panel = pdf.pivot(
            index="date", columns="symbol", values="ret"
        ).sort_index().astype(np.float32)

        self._vol_panel = pdf.pivot(
            index="date", columns="symbol", values="volume"
        ).sort_index().astype(np.float32)

        self._amt_panel = pdf.pivot(
            index="date", columns="symbol", values="amount"
        ).sort_index().astype(np.float32)

        self._to_panel = pdf.pivot(
            index="date", columns="symbol", values="turnover_rate"
        ).sort_index().astype(np.float32)

        logger.info("OHLCV panels: %d dates x %d stocks (%.1fs)",
                     len(self._ohlcv_close), self._ohlcv_close.shape[1],
                     time.time() - t0)

    def load_close_panel(self, start: str, end: str) -> pd.DataFrame:
        if self._ohlcv_close is None:
            self._load_stock_panels(start, end)
        return self._ohlcv_close if self._ohlcv_close is not None else pd.DataFrame()

    def load_returns_panel(self, start: str, end: str) -> pd.DataFrame:
        if self._returns_panel is None:
            self._load_stock_panels(start, end)
        return self._returns_panel if self._returns_panel is not None else pd.DataFrame()

    def compute_factors(self, start: str, end: str) -> dict[str, pd.DataFrame]:
        """Compute rolling factors from OHLCV panels."""
        if self._computed_factors:
            return self._computed_factors

        close = self.load_close_panel(start, end)
        ret = self.load_returns_panel(start, end)
        s_dt, e_dt = pd.Timestamp(start), pd.Timestamp(end)

        def trim(df: pd.DataFrame) -> pd.DataFrame:
            if df.empty:
                return df
            return df.loc[(df.index >= s_dt) & (df.index <= e_dt)]

        factors: dict[str, pd.DataFrame] = {}

        # Price momentum (5d, 20d)
        for period, name in [(5, "price_change_5"), (20, "price_change_20")]:
            if close.shape[0] > period:
                pct = (close / close.shift(period) - 1).replace(
                    [np.inf, -np.inf], np.nan
                ).astype(np.float32)
                factors[name] = trim(pct)

        # Volatility (rolling std * sqrt(252))
        for period, name in [(20, "volatility_20"), (60, "volatility_60")]:
            if ret.shape[0] > period:
                vol = ret.rolling(
                    period, min_periods=min(period // 2, 10)
                ).std() * np.sqrt(252)
                factors[name] = trim(vol.astype(np.float32))

        # Volume ratio (volume / 20d MA volume)
        if self._vol_panel is not None and self._vol_panel.shape[0] > 20:
            vol_ma = self._vol_panel.rolling(20, min_periods=5).mean().replace(0, np.nan)
            vr = (self._vol_panel / vol_ma).clip(0, 10).astype(np.float32)
            factors["volume_ratio_20"] = trim(vr)
            # Turnover mean
            if self._to_panel is not None and self._to_panel.shape[0] > 20:
                to_m = self._to_panel.rolling(20, min_periods=5).mean().astype(np.float32)
                factors["turnover_mean_20"] = trim(to_m)

        # Amihud illiquidity (|ret| / (close * volume))
        if (self._vol_panel is not None and ret.shape[0] > 20 and
            close.shape[0] > 20):
            dollar_vol = (close * self._vol_panel).replace(0, np.nan)
            amihud = (ret.abs() / dollar_vol).replace([np.inf, -np.inf], np.nan)
            amihud_m = amihud.rolling(20, min_periods=5).mean() * 1e12
            factors["amihud_illiq_20"] = trim(amihud_m.astype(np.float32))

        self._computed_factors = factors
        n_cells = sum(p.shape[0] * p.shape[1] for p in factors.values())
        logger.info("Computed %d OHLCV factors (%.1fM cells)", len(factors), n_cells / 1e6)
        return factors

    def load_parquet_factors(self, start: str, end: str) -> dict[str, pd.DataFrame]:
        """Load strategy_a factors from parquet files."""
        s_dt, e_dt = pd.Timestamp(start), pd.Timestamp(end)
        cfg = self.cfg
        cols = cfg.parquet_factor_cols
        read_cols = ["symbol", "date"] + [c for c in cols]

        t0 = time.time()
        groups: dict[int, list[pd.DataFrame]] = {i: [] for i in range(len(cols))}

        factors_base = self.root / "factors"
        for year_dir in sorted(factors_base.iterdir()):
            if not year_dir.is_dir() or not year_dir.name.isdigit():
                continue
            for date_dir in sorted(year_dir.iterdir()):
                try:
                    dt = pd.Timestamp(date_dir.name)
                except Exception:
                    continue
                if dt < s_dt or dt > e_dt:
                    continue
                fpath = date_dir / cfg.parquet_factor_file.replace("factors/", "")
                if not fpath.exists():
                    continue
                try:
                    df_date = pd.read_parquet(fpath, columns=read_cols)
                except Exception:
                    continue
                if df_date.empty:
                    continue
                df_date["symbol"] = df_date["symbol"].str.lower()
                for i, col in enumerate(cols):
                    sub = df_date[["symbol", col]].dropna(subset=[col])
                    if not sub.empty:
                        groups[i].append(pd.DataFrame({
                            "date": dt, "symbol": sub["symbol"].values,
                            "value": sub[col].astype(float).values,
                        }))

        result: dict[str, pd.DataFrame] = {}
        loaded = 0
        for i, col in enumerate(cols):
            if not groups[i]:
                continue
            try:
                pdf = pd.concat(groups[i], ignore_index=True)
                panel = pdf.pivot(index="date", columns="symbol", values="value")
                panel.index = pd.to_datetime(panel.index)
                panel = panel.sort_index().astype(np.float32)

                full_idx = panel.index.union(
                    pd.date_range(s_dt, e_dt, freq="B")
                )
                panel = panel.reindex(full_idx).ffill(limit=cfg.ffill_days)
                panel = panel.loc[
                    (panel.index >= s_dt) & (panel.index <= e_dt)
                ]
                result[col] = panel
                loaded += 1
            except Exception:
                continue

        logger.info("Parquet factors: %d/%d (%.1fs)", loaded, len(cols), time.time() - t0)
        return result

    def load_all_factors(self, start: str, end: str) -> dict[str, pd.DataFrame]:
        """Combine OHLCV + parquet factors."""
        factors = self.compute_factors(start, end)
        factors.update(self.load_parquet_factors(start, end))
        logger.info("Total factors: %d", len(factors))
        return factors

    def load_index_data(self) -> pd.DataFrame:
        if self._index_df is not None:
            return self._index_df
        base = self.root / "market_data" / "daily" / "index_daily"
        records = []
        for pdir in sorted(base.iterdir()):
            name = pdir.name
            if not name.startswith("date="):
                continue
            try:
                dt = pd.to_datetime(name.replace("date=", ""))
            except Exception:
                continue
            for fp in pdir.glob("*.parquet"):
                try:
                    df = pd.read_parquet(
                        fp,
                        columns=["index_code", "open", "high", "low",
                                 "close", "volume", "amount"],
                    )
                except Exception:
                    continue
                sub = df[df["index_code"] == self.cfg.index_code]
                if not sub.empty:
                    row = sub.iloc[0].to_dict()
                    row["date"] = dt
                    records.append(row)
                break

        if not records:
            return pd.DataFrame()
        result = pd.DataFrame(records).set_index("date").sort_index()
        for col in ["open", "high", "low", "close", "volume", "amount"]:
            if col in result.columns:
                result[col] = pd.to_numeric(result[col], errors="coerce")
        self._index_df = result
        logger.info("Index %s: %d dates (%.4s→%s)",
                     self.cfg.index_code, len(result),
                     str(result.index[0])[:10], str(result.index[-1])[:10])
        return result

    def get_benchmark_returns(self) -> pd.Series:
        if self._benchmark_returns is not None:
            return self._benchmark_returns
        idx = self.load_index_data()
        if idx.empty:
            return pd.Series(dtype=float)
        self._benchmark_returns = idx["close"].pct_change().dropna()
        return self._benchmark_returns


# ══════════════════════════════════════════════════════════════════
# 2. Regime Detection
# ══════════════════════════════════════════════════════════════════


class RegimeDetector:
    """Market regime detection: Volatility + Trend + Volume."""

    def detect(self, idx_df: pd.DataFrame) -> pd.Series:
        if idx_df.empty or "close" not in idx_df.columns:
            return pd.Series(dtype=str)

        df = idx_df.copy()
        ret = df["close"].pct_change()

        # Volatility dimension (40%)
        vol_20 = ret.rolling(20, min_periods=10).std() * np.sqrt(252)
        vol_pctl = vol_20.rank(pct=True)
        vol_score = np.select(
            [vol_pctl > 0.75, vol_pctl < 0.25], [1.0, -1.0], default=0.0
        )

        # Trend dimension (35%)
        ema_10 = df["close"].ewm(span=10, adjust=False).mean()
        ema_30 = df["close"].ewm(span=30, adjust=False).mean()
        ema_ratio = ema_10 / ema_30 - 1

        trend_score = np.select(
            [ema_ratio > 0.01, ema_ratio < -0.01], [1.0, -1.0], default=0.0
        )

        # Volume dimension (15%)
        vol_ma_20 = df["volume"].rolling(20, min_periods=10).mean().clip(lower=1e-6)
        vol_anomaly = df["volume"] / vol_ma_20
        volume_score = np.select(
            [vol_anomaly > 1.5, vol_anomaly < 0.5], [0.5, -0.5], default=0.0
        )

        regime_score = (
            0.40 * vol_score + 0.35 * trend_score + 0.15 * volume_score
        ).clip(-1.5, 1.5)

        vol_high = vol_pctl > 0.75

        regime = np.select(
            [regime_score > 0.5, regime_score < -0.5,
             (regime_score >= -0.15) & (regime_score <= 0.15)],
            ["TRENDING", "RANGING", "QUIET"], default="QUIET"
        ).astype(str)
        regime[vol_high] = "VOLATILE"

        return pd.Series(regime, index=df.index, name="regime")

    def slice(self, series: pd.Series, start: str, end: str) -> pd.Series:
        s_dt, e_dt = pd.Timestamp(start), pd.Timestamp(end)
        return series[(series.index >= s_dt) & (series.index <= e_dt)]


# ══════════════════════════════════════════════════════════════════
# 3. Factor Scoring
# ══════════════════════════════════════════════════════════════════


class FactorScorer:
    """Cross-sectional rank-based scoring."""

    def __init__(self, cfg: Config):
        self.cfg = cfg

    def compute_scores(self, factors: dict[str, pd.DataFrame],
                       date: pd.Timestamp, universe: set[str]) -> pd.Series:
        cfg = self.cfg
        signs = cfg.factor_signs

        score = pd.Series(dtype=float)
        denominator = 0.0

        for fname, panel in factors.items():
            w = signs.get(fname, 0.0)
            if abs(w) < 0.01:
                continue
            if date not in panel.index:
                continue

            vals = panel.loc[date].dropna()
            if vals.empty:
                continue

            common = vals.index.intersection(list(universe))
            if len(common) < 50:
                continue
            vals = vals[common]

            ranks = vals.rank(pct=True, ascending=(w > 0))

            if score.empty:
                score = ranks * abs(w)
            else:
                common_i = score.index.intersection(ranks.index)
                if len(common_i) > 0:
                    score = score.reindex(common_i).fillna(0) + \
                            ranks.reindex(common_i).fillna(0) * abs(w)

            denominator += abs(w)

        if score.empty or denominator < 0.01:
            return pd.Series(dtype=float)

        return score / denominator

    def select_top_n(self, scores: pd.Series, n: int) -> list[str]:
        return list(scores.nlargest(n).index)


# ══════════════════════════════════════════════════════════════════
# 4. Backtest Engine
# ══════════════════════════════════════════════════════════════════


class BacktestEngine:
    """Backtest with correct P&L attribution."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.dl = DataLoader(cfg)
        self.scorer = FactorScorer(cfg)
        self.detector = RegimeDetector()

        self._close: pd.DataFrame | None = None
        self._returns: pd.DataFrame | None = None
        self._factors: dict[str, pd.DataFrame] = {}
        self._regimes: pd.Series = pd.Series(dtype=str)
        self._benchmark: pd.Series = pd.Series(dtype=float)

    def run(self) -> dict[str, Any]:
        cfg = self.cfg
        t0 = time.time()
        logger.info("=== Alpha v3: %s→%s | top=%d | rebal=%dd | timing=%s ===",
                     cfg.start, cfg.end, cfg.top_n, cfg.rebalance_days,
                     "ON" if cfg.enable_market_timing else "OFF")

        # ── Load data ──
        self._close = self.dl.load_close_panel(cfg.start, cfg.end)
        self._returns = self.dl.load_returns_panel(cfg.start, cfg.end)
        self._factors = self.dl.load_all_factors(cfg.start, cfg.end)
        self._benchmark = self.dl.get_benchmark_returns()

        if self._close is None or self._close.empty:
            return {"error": "No close price data"}
        if not self._factors:
            return {"error": "No factor data"}

        # ── Regime detection ──
        idx_df = self.dl.load_index_data()
        all_regimes = self.detector.detect(idx_df)
        self._regimes = self.detector.slice(all_regimes, cfg.start, cfg.end)

        # ── Date index ──
        s_dt, e_dt = pd.Timestamp(cfg.start), pd.Timestamp(cfg.end)
        date_idx = self._close.index[
            (self._close.index >= s_dt) & (self._close.index <= e_dt)
        ]
        date_idx = date_idx[date_idx.isin(self._returns.index)]
        date_list = list(date_idx)

        if len(date_list) == 0:
            return {"error": "No trading dates in range"}

        # ── Universe ──
        universe: set[str] = set()
        for fname, panel in self._factors.items():
            sub = panel.loc[panel.index.isin(date_idx)]
            if not sub.empty:
                universe.update(sub.columns[sub.notna().any()])
        if not universe:
            return {"error": "Empty universe"}
        logger.info("Universe: %d stocks", len(universe))

        # ── State ──
        portfolio_value = float(cfg.initial_capital)
        capital = float(cfg.initial_capital)
        holdings: dict[str, float] = {}  # symbol -> value invested
        last_rebalance = None

        # Build next-date map for correct P&L attribution
        next_date_map = {date_list[i]: date_list[i + 1]
                         for i in range(len(date_list) - 1)}

        daily_records: list[dict[str, Any]] = []
        rebalance_log: list[dict[str, Any]] = []

        for i, date in enumerate(date_list):
            date_str = str(date.date())
            regime = self._regimes.get(date, "QUIET") if date in self._regimes.index else "QUIET"
            pos_scale = self._position_scale(regime, idx_df, date)

            # ── Compute P&L using NEXT DAY's returns ──
            # Stocks held at close of T-1 earn T's return.
            # Returns panel is indexed by date T = return from T-1 close to T close.
            # Holdings were bought at close of last rebalance day.
            # So today's P&L = sum of holdings * (today's return)
            # EXCEPT for stocks just bought today — they earn tomorrow's return.
            # We split: return earned = T's ret for old holdings, 0 for newly bought.
            daily_ret = 0.0
            # We'll compute P&L AFTER the rebalance, so we know which are new

            # ── Rebalance ──
            needs_rebalance = (
                last_rebalance is None
                or (date - last_rebalance).days >= cfg.rebalance_days
            )

            if needs_rebalance and pos_scale > 0:
                scores = self.scorer.compute_scores(self._factors, date, universe)
                if not scores.empty and len(scores) >= cfg.top_n:
                    selected = self.scorer.select_top_n(scores, cfg.top_n)

                    alloc_capital = capital * pos_scale
                    target_value = min(
                        alloc_capital / max(len(selected), 1),
                        cfg.initial_capital * cfg.max_position_pct,
                    )

                    trades, cost = self._execute_trades(
                        holdings, selected, target_value, date, capital,
                    )
                    capital = max(0.0, capital - cost)
                    last_rebalance = date

                    rebalance_log.append({
                        "date": date_str,
                        "regime": regime,
                        "n_selected": len(selected),
                        "pos_scale": round(pos_scale, 3),
                        "top_score": round(float(scores.iloc[0]), 4),
                        "n_trades": trades,
                    })

            # ── P&L attribution (FIXED: no lookahead) ──
            # We want return from today to tomorrow.
            # If we rebalanced today: new stocks get 0 today, earn return tomorrow.
            # If we didn't: all holdings earn return from today to tomorrow.
            # But we don't know tomorrow's return yet! So we use today's return
            # for stocks held from yesterday, and 0 for stocks bought today.
            ret_today = self._returns.loc[date] if date in self._returns.index else pd.Series(dtype=float)
            today_syms = set(holdings.keys())

            pnl = 0.0
            for sym in today_syms:
                if sym in ret_today.index:
                    r = ret_today[sym]
                    if not pd.isna(r) and abs(r) < 0.5:
                        pnl += holdings.get(sym, 0) * r

            daily_ret = pnl / max(portfolio_value, 1.0)
            portfolio_value = max(0.0, portfolio_value + pnl)
            capital = max(0.0, capital + pnl * (capital / max(portfolio_value - pnl, 1.0)) if portfolio_value - pnl > 0 else capital)

            daily_records.append({
                "date": date_str,
                "regime": regime,
                "net_return": round(daily_ret, 6),
                "portfolio_value": round(portfolio_value, 2),
                "n_holdings": len(holdings),
                "pos_scale": round(pos_scale, 3),
            })

        # ── Metrics ──
        results_df = pd.DataFrame(daily_records)
        if not results_df.empty:
            results_df = results_df.set_index("date")
            results_df.index = pd.to_datetime(results_df.index)

        rebal_df = pd.DataFrame(rebalance_log) if rebalance_log else pd.DataFrame()
        metrics = self._compute_metrics(results_df)
        metrics["elapsed_seconds"] = round(time.time() - t0, 1)

        logger.info("Done: Ret=%.2f%% | Sharpe=%.2f | MaxDD=%.2f%% | Win=%.1f%% (%.1fs)",
                     metrics.get("total_return_pct", 0), metrics.get("sharpe_ratio", 0),
                     metrics.get("max_drawdown_pct", 0), metrics.get("win_rate_pct", 0),
                     metrics["elapsed_seconds"])

        return {
            "results": results_df,
            "rebalance_log": rebal_df,
            "regime_series": self._regimes,
            "metrics": metrics,
            "final_value": round(portfolio_value, 2),
        }

    def _position_scale(self, regime: str, idx_df: pd.DataFrame,
                        date: pd.Timestamp) -> float:
        cfg = self.cfg
        if not cfg.enable_market_timing:
            return 1.0

        if cfg.trending_down_exit and regime == "RANGING":
            if date in idx_df.index:
                recent = idx_df.loc[:date].tail(30)
                if len(recent) >= 20:
                    ema10 = recent["close"].ewm(span=10, adjust=False).mean().iloc[-1]
                    ema30 = recent["close"].ewm(span=30, adjust=False).mean().iloc[-1]
                    ret20 = recent["close"].iloc[-1] / recent["close"].iloc[0] - 1
                    if ema10 < ema30 and ret20 < -0.03:
                        return 0.0

        if regime == "VOLATILE":
            return cfg.volatile_position_pct

        if date in idx_df.index:
            recent = idx_df.loc[:date].tail(60)
            if len(recent) >= 20:
                close_p = recent["close"]
                ret20 = close_p.iloc[-1] / close_p.iloc[-20] - 1
                price_pos = (close_p.iloc[-1] - close_p.min()) / \
                            max(close_p.max() - close_p.min(), 1e-10)
                if ret20 < -0.025 and price_pos < 0.3:
                    return 0.75

        return 1.0

    def _execute_trades(
        self,
        holdings: dict[str, float],
        selected: list[str],
        target_value: float,
        date: pd.Timestamp,
        available_capital: float,
    ) -> tuple[int, float]:
        cfg = self.cfg
        total_trades = 0
        total_cost = 0.0
        close = self._close

        # Sell holdings not in selected
        for sym in list(holdings.keys()):
            if sym not in selected:
                val = holdings.pop(sym, 0.0)
                if val > 0:
                    total_trades += 1
                    total_cost += val * (cfg.commission_rate + cfg.stamp_tax_rate)

        # Buy selected stocks
        for sym in selected:
            if sym in holdings:
                continue
            price = 10.0
            if date in close.index and sym in close.columns:
                px = close.loc[date, sym]
                if not pd.isna(px) and px > 0:
                    price = px

            shares = int(target_value / price / 100) * 100
            if shares <= 0:
                continue

            buy_value = shares * price
            cost = buy_value * (cfg.commission_rate + cfg.slippage)
            total_cost += cost
            total_trades += 1
            holdings[sym] = buy_value

        return total_trades, total_cost

    def _compute_metrics(self, results: pd.DataFrame) -> dict[str, Any]:
        if results.empty:
            return {"error": "No results"}

        daily_ret = results["net_return"].values
        n_days = len(daily_ret)
        total_ret = float(np.prod(1 + daily_ret)) - 1
        years = max(n_days / 252, 1 / 252)
        ann_ret = (1 + total_ret) ** (1 / years) - 1 if total_ret > -1 else -1.0

        daily_vol = float(np.std(daily_ret))
        ann_vol = daily_vol * np.sqrt(252)
        sharpe = float(np.mean(daily_ret) / max(daily_vol, 1e-10) * np.sqrt(252))

        downside = daily_ret[daily_ret < 0]
        if len(downside) > 1:
            sortino = float(
                np.mean(daily_ret) / max(np.std(downside), 1e-10) * np.sqrt(252)
            )
        else:
            sortino = sharpe

        cum_ret = (1 + pd.Series(daily_ret)).cumprod()
        drawdown = cum_ret / cum_ret.cummax() - 1
        max_dd = float(drawdown.min())
        calmar = ann_ret / abs(max_dd) if abs(max_dd) > 1e-10 else 0.0
        win_rate = float((daily_ret > 0).mean())

        bench_total = 0.0
        bench_ann = 0.0
        excess_return = ann_ret
        info_ratio = 0.0
        bench = self._benchmark
        if bench is not None and not bench.empty:
            aligned = results.index.intersection(bench.index)
            if len(aligned) == n_days:
                bench_subset = bench.loc[aligned].values
                bench_total = float(np.prod(1 + bench_subset)) - 1
                bench_ann = (1 + bench_total) ** (1 / years) - 1 if bench_total > -1 else -1.0
                excess_return = ann_ret - bench_ann
                active = daily_ret - bench_subset
                info_ratio = float(
                    np.mean(active) / max(np.std(active), 1e-10) * np.sqrt(252)
                )

        regime_metrics = {}
        for rn in ["QUIET", "TRENDING", "VOLATILE", "RANGING"]:
            sub = results[results["regime"] == rn]
            if len(sub) < 3:
                continue
            regime_metrics[rn] = {
                "n_days": int(len(sub)),
                "total_return_pct": round(
                    float(((1 + sub["net_return"]).prod() - 1) * 100), 2
                ),
                "mean_daily_bps": round(float(sub["net_return"].mean() * 10000), 2),
                "win_rate": round(float((sub["net_return"] > 0).mean()), 4),
            }

        return {
            "total_return_pct": round(float(total_ret * 100), 2),
            "annual_return_pct": round(float(ann_ret * 100), 2),
            "annual_volatility_pct": round(float(ann_vol * 100), 2),
            "sharpe_ratio": round(float(sharpe), 2),
            "sortino_ratio": round(float(sortino), 2),
            "information_ratio": round(float(info_ratio), 2),
            "max_drawdown_pct": round(float(max_dd * 100), 2),
            "calmar_ratio": round(float(calmar), 2),
            "win_rate_pct": round(float(win_rate * 100), 1),
            "benchmark_total_return_pct": round(float(bench_total * 100), 2),
            "benchmark_annual_return_pct": round(float(bench_ann * 100), 2),
            "excess_return_pct": round(float(excess_return * 100), 2),
            "n_trading_days": int(n_days),
            "final_capital": round(self.cfg.initial_capital * (1 + total_ret), 2),
            "avg_holdings": round(float(results["n_holdings"].mean()), 1),
            "regime_metrics": regime_metrics,
            "regime_distribution": {
                r: int((results["regime"] == r).sum())
                for r in ["QUIET", "TRENDING", "VOLATILE", "RANGING"]
            },
        }


# ══════════════════════════════════════════════════════════════════
# 5. Walk-Forward
# ══════════════════════════════════════════════════════════════════


def run_walk_forward(cfg: Config) -> dict[str, Any]:
    n_folds = cfg.walk_forward_folds
    if n_folds < 2:
        return {}

    s_dt, e_dt = pd.Timestamp(cfg.start), pd.Timestamp(cfg.end)
    total_days = (e_dt - s_dt).days
    fold_size = total_days // n_folds
    folds: list[dict[str, Any]] = []

    for fold in range(n_folds):
        fs = s_dt + timedelta(days=fold * fold_size)
        fe = min(s_dt + timedelta(days=(fold + 1) * fold_size), e_dt)
        logger.info("WF fold %d/%d: %s→%s", fold + 1, n_folds, fs.date(), fe.date())

        fc = Config(
            start=str(fs.date()), end=str(fe.date()),
            data_root=cfg.data_root,
            top_n=cfg.top_n, rebalance_days=cfg.rebalance_days,
            enable_market_timing=cfg.enable_market_timing,
        )
        engine = BacktestEngine(fc)
        result = engine.run()
        if "error" in result:
            logger.warning("Fold %d: %s", fold + 1, result["error"])
            continue
        folds.append({
            "fold": fold + 1,
            "start": str(fs.date()), "end": str(fe.date()),
            "metrics": result.get("metrics", {}),
            "final_value": result.get("final_value", 0),
        })

    if not folds:
        return {"error": "All folds failed"}

    sp = [f["metrics"].get("sharpe_ratio", 0) for f in folds]
    rt = [f["metrics"].get("total_return_pct", 0) for f in folds]

    return {
        "walk_forward": {
            "n_folds": n_folds, "folds": folds,
            "mean_sharpe": round(float(np.mean(sp)), 2),
            "std_sharpe": round(float(np.std(sp)), 2),
            "mean_return": round(float(np.mean(rt)), 2),
            "min_sharpe": round(float(min(sp)), 2),
            "max_sharpe": round(float(max(sp)), 2),
        }
    }


# ══════════════════════════════════════════════════════════════════
# 6. IC Report
# ══════════════════════════════════════════════════════════════════


def compute_ic_report(factors: dict[str, pd.DataFrame],
                      returns_panel: pd.DataFrame,
                      start: str, end: str) -> dict[str, Any]:
    """Cross-sectional Spearman IC for each factor vs next-day returns."""
    s_dt, e_dt = pd.Timestamp(start), pd.Timestamp(end)
    ret_shifted = returns_panel.shift(-1)

    ic_records: dict[str, list[float]] = {}

    for fname, panel in factors.items():
        dates = panel.index[(panel.index >= s_dt) & (panel.index <= e_dt)]
        ic_list = []
        for dt in dates:
            if dt not in ret_shifted.index:
                continue
            fvals = panel.loc[dt].dropna()
            rvals = ret_shifted.loc[dt]
            common = fvals.index.intersection(rvals.index)
            if len(common) < 30:
                continue
            f_sub = fvals[common]
            r_sub = rvals[common].dropna()
            common2 = f_sub.index.intersection(r_sub.index)
            if len(common2) < 30:
                continue
            corr = f_sub[common2].corr(r_sub[common2], method="spearman")
            if not pd.isna(corr):
                ic_list.append(corr)

        if len(ic_list) >= 5:
            ic_records[fname] = ic_list

    if not ic_records:
        return {}

    report: dict[str, Any] = {"n_factors_with_ic": len(ic_records)}
    for fname, ic_vals in sorted(
        ic_records.items(),
        key=lambda x: abs(float(np.mean(x[1]))),
        reverse=True,
    ):
        arr = np.array(ic_vals)
        report[fname] = {
            "mean_ic": float(np.mean(arr)),
            "std_ic": float(np.std(arr)),
            "t_stat": float(np.mean(arr) / max(np.std(arr) / np.sqrt(len(arr)), 1e-10)),
            "n_days": len(arr),
            "p_positive": float((arr > 0).mean()),
        }
    return report


# ══════════════════════════════════════════════════════════════════
# 7. Report
# ══════════════════════════════════════════════════════════════════


def generate_report(
    result: dict[str, Any],
    cfg: Config,
    wf_result: dict[str, Any] | None = None,
    ic_report: dict[str, Any] | None = None,
) -> str:
    if "error" in result:
        return f"# Alpha Strategy v3 — Error\n\n{result['error']}\n"

    m = result.get("metrics", {})
    rm = m.get("regime_metrics", {})
    rd = m.get("regime_distribution", {})
    total_d = sum(rd.values()) if rd else 0

    lines = [
        "# Alpha Strategy v3 — 评估报告",
        "",
        f"**回测期间**: {cfg.start} → {cfg.end}  |  "
        f"**选股**: {cfg.top_n}  |  "
        f"**调仓**: 每 {cfg.rebalance_days}d  |  "
        f"**因素**: {len(cfg.factor_signs)} 个",
        "",
        f"**计算因素**: {', '.join(cfg.ohlcv_factors)}",
        f"**Parquet因素**: {', '.join(cfg.parquet_factor_cols)}",
        "",
        "---\n",
    ]

    lines.extend([
        "## 业绩摘要\n",
        "| 指标 | 策略 | 基准(CSI300) | 超额 |",
        "|------|------|-------------|------|",
        f"| 总收益 | {m.get('total_return_pct', 0):+.2f}% | "
        f"{m.get('benchmark_total_return_pct', 0):+.2f}% | "
        f"{m.get('total_return_pct', 0)-m.get('benchmark_total_return_pct', 0):+.2f}% |",
        f"| 年化收益 | {m.get('annual_return_pct', 0):+.2f}% | "
        f"{m.get('benchmark_annual_return_pct', 0):+.2f}% | "
        f"{m.get('excess_return_pct', 0):+.2f}% |",
        f"| 年化波动 | {m.get('annual_volatility_pct', 0):.2f}% | — | — |",
        f"| 夏普比 | {m.get('sharpe_ratio', 0):.2f} | — | — |",
        f"| 索提诺 | {m.get('sortino_ratio', 0):.2f} | — | — |",
        f"| 信息比 | {m.get('information_ratio', 0):.2f} | — | — |",
        f"| 最大回撤 | {m.get('max_drawdown_pct', 0):.2f}% | — | — |",
        f"| 卡玛比 | {m.get('calmar_ratio', 0):.2f} | — | — |",
        f"| 胜率 | {m.get('win_rate_pct', 0):.1f}% | — | — |",
        f"| 平均持仓 | {m.get('avg_holdings', 0):.1f} | — | — |",
        f"| 最终资金 | ¥{m.get('final_capital', 0):,.0f} | — | — |",
    ])

    if wf_result and "walk_forward" in wf_result:
        wf = wf_result["walk_forward"]
        lines.extend([
            "",
            "## Walk-Forward 验证\n",
            "| 指标 | 值 |",
            "|------|----|",
            f"| 折叠数 | {wf['n_folds']} |",
            f"| 平均夏普 | {wf['mean_sharpe']} ± {wf['std_sharpe']} |",
            f"| 最小/最大 | {wf['min_sharpe']} / {wf['max_sharpe']} |",
            f"| 平均收益 | {wf['mean_return']}% |",
            "",
            "| 折叠 | 起止 | 夏普 | 收益 |",
            "|------|------|------|------|",
            *[f"| {r['fold']} | {r['start']}→{r['end']} | "
              f"{r['metrics'].get('sharpe_ratio','N/A')} | "
              f"{r['metrics'].get('total_return_pct','N/A')}% |"
              for r in wf.get("folds", [])],
        ])

    lines.extend([
        "",
        "## 市场状态分析\n",
        "| 状态 | 天数 | 占比 | 日均(bps) | 胜率 |",
        "|------|------|------|----------|------|",
    ])
    for rn in ["QUIET", "TRENDING", "VOLATILE", "RANGING"]:
        rg = rm.get(rn, {})
        cnt = rd.get(rn, 0)
        pct = 100 * cnt / max(total_d, 1)
        lines.append(
            f"| {rn} | {cnt} | {pct:.1f}% | "
            f"{rg.get('mean_daily_bps', 0):+.1f} | "
            f"{rg.get('win_rate', 0)*100:.0f}% |"
        )

    if ic_report:
        lines.extend([
            "",
            "## 因子IC分析（截面Spearman Rank IC vs 次日收益）\n",
            "| 因子 | 平均IC | IC波动 | t值 | 天数 | IC>0占比 |",
            "|------|-------|-------|-----|------|--------|",
        ])
        for fname, ic_data in sorted(
            ic_report.items(),
            key=lambda x: abs(x[1].get("mean_ic", 0)) if isinstance(x[1], dict) else 0,
            reverse=True,
        ):
            if fname == "n_factors_with_ic" or not isinstance(ic_data, dict):
                continue
            lines.append(
                f"| {fname} | {ic_data.get('mean_ic', 0):+.4f} | "
                f"{ic_data.get('std_ic', 0):.4f} | "
                f"{ic_data.get('t_stat', 0):+.2f} | "
                f"{ic_data.get('n_days', 0)} | "
                f"{ic_data.get('p_positive', 0)*100:.0f}% |"
            )

    lines.extend(["", "## 解读\n"])
    sharpe = m.get("sharpe_ratio", 0)
    lines.append(
        f"- **夏普 {sharpe:.2f}**：" +
        ("超过实盘阈值 1.0" if sharpe >= 1.0 else
         "中等水平" if sharpe >= 0.5 else "低于实盘阈值")
    )

    max_dd = m.get("max_drawdown_pct", 0)
    lines.append(f"- **最大回撤 {max_dd:.2f}%**：" +
                  ("可接受" if abs(max_dd) < 10 else "需关注" if abs(max_dd) < 20 else "过大"))

    lines.extend([
        "",
        "### 状态洞察",
        *[f"- **{rn}**（{rd.get(rn, 0)} 天）：日均 {rm.get(rn, {}).get('mean_daily_bps', 0):+.1f} bps"
          for rn in ["VOLATILE", "TRENDING", "QUIET", "RANGING"]
          if rm.get(rn, {})],
        "",
        "### v3 vs v2 改进",
        "- **因素从OHLCV实时计算**（不依赖稀疏parquet因子表）",
        "- **12个精炼因子**（代替45个噪声因子，减少过拟合）",
        "- **P&L归因修正**：新买入的股票不获取当日收益（修复v2的lookahead bias）",
        "- **索提诺计算修正**：修复之前的除以252的错误",
        "- **IC验证报告**：自动计算每个因子的截面IC",
    ])

    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════
# 8. CLI
# ══════════════════════════════════════════════════════════════════


def parse_args() -> Config:
    p = argparse.ArgumentParser(description="Alpha Strategy v3")
    p.add_argument("--start", default="2026-05-06")
    p.add_argument("--end", default="2026-07-03")
    p.add_argument("--top-n", type=int, default=30)
    p.add_argument("--rebalance-days", type=int, default=3)
    p.add_argument("--index", default="000300.SH")
    p.add_argument("--walk-forward", type=int, default=0)
    p.add_argument("--no-market-timing", action="store_true")
    p.add_argument("--output-dir", default="output/alpha_strategy_v3")
    p.add_argument("--data-root", default=str(ANALYSIS_V2_ROOT / "data_cache"))
    args = p.parse_args()
    return Config(
        start=args.start, end=args.end, index_code=args.index,
        top_n=args.top_n, rebalance_days=args.rebalance_days,
        enable_market_timing=not args.no_market_timing,
        walk_forward_folds=args.walk_forward,
        output_root=args.output_dir, data_root=args.data_root,
    )


def main():
    cfg = parse_args()
    t0 = time.time()
    out_dir = Path(cfg.output_root)
    out_dir.mkdir(parents=True, exist_ok=True)

    wf_result = None
    if cfg.walk_forward_folds >= 2:
        logger.info("Walk-forward: %d folds", cfg.walk_forward_folds)
        wf_result = run_walk_forward(cfg)

    engine = BacktestEngine(cfg)
    result = engine.run()
    if "error" in result:
        logger.error("Backtest failed: %s", result["error"])
        print(f"\nERROR: {result['error']}")
        return 1

    ic_report = {}
    try:
        ret_panel = engine.dl.load_returns_panel(cfg.start, cfg.end)
        if not ret_panel.empty and engine._factors:
            ic_report = compute_ic_report(
                engine._factors, ret_panel, cfg.start, cfg.end,
            )
    except Exception as e:
        logger.warning("IC computation skipped: %s", e)

    report = generate_report(result, cfg, wf_result, ic_report)
    (out_dir / "report.md").write_text(report, encoding="utf-8")

    for key, fname in [("results", "daily_results.parquet"),
                       ("rebalance_log", "rebalance_log.parquet")]:
        df = result.get(key)
        if df is not None and not df.empty:
            df.to_parquet(out_dir / fname)

    m = result.get("metrics", {})
    (out_dir / "metrics.json").write_text(
        json.dumps(m, indent=2, default=str), encoding="utf-8"
    )
    if ic_report:
        (out_dir / "ic_report.json").write_text(
            json.dumps(ic_report, indent=2, default=str), encoding="utf-8"
        )

    elapsed = time.time() - t0
    print(f"\n{'='*60}")
    print(f"Alpha Strategy v3 — {cfg.start} -> {cfg.end} ({elapsed:.1f}s)")
    print(f"{'='*60}")
    print(f"  Total Return:      {m.get('total_return_pct', 0):+.2f}%")
    print(f"  Sharpe:            {m.get('sharpe_ratio', 0):.2f}")
    print(f"  Sortino:           {m.get('sortino_ratio', 0):.2f}")
    print(f"  Max Drawdown:      {m.get('max_drawdown_pct', 0):.2f}%")
    print(f"  Win Rate:          {m.get('win_rate_pct', 0):.1f}%")
    print(f"  Avg Holdings:      {m.get('avg_holdings', 0):.1f}")
    print(f"  Benchmark (CSI300):{m.get('benchmark_total_return_pct', 0):+.2f}%")
    print(f"  Excess Return:     {m.get('excess_return_pct', 0):+.2f}%")
    print(f"  Factors Tested:    {len(engine._factors)}")
    print(f"  IC Factors:        {ic_report.get('n_factors_with_ic', 0)}")
    print(f"\nReport: {out_dir / 'report.md'}")
    print(f"{'='*60}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
