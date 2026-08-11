"""
daily_hotspot_report.py
========================
「抓热点板块」日报脚本 —— 把 4 个 notebook 的核心逻辑统一到一个脚本。

覆盖：
  A1. 02 板块轮动打分     → section_score_top_industries()
  A2. 64 板块动量趋势     → section_momentum_top_industries()
  A3. 98 热点行业和热点概念 → section_concept_lead_stocks()
  A4. 89 行业情绪专题     → section_industry_nhnl_signal()

依赖：
  pip install jk2bt akshare pandas numpy

跑法：
  python strategies/daily_hotspot_report.py --date 2026-06-27
  python strategies/daily_hotspot_report.py            # 默认昨天
"""
from __future__ import annotations
import argparse
import datetime as dt
import sys
import warnings
from pathlib import Path
from typing import Dict, List, Tuple

import pandas as pd

warnings.filterwarnings("ignore")

# 把 jk2bt 加入 path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jk2bt.api import (
    get_all_securities,
    get_security_info,
    get_price,
    get_industry,
    get_stock_industry,
    # 注：jk2bt 暴露的是 get_concept_stocks；行业/概念在同一接口下
    get_concept_stocks,
    get_all_concepts,
    get_concepts,
)
from jk2bt.api.market import attribute_history
from jk2bt.api.date import get_previous_trade_date, get_trade_days


# =============================================================================
# 兼容层：行业 → 成分股（jk2bt 实际暴露的是 get_concept_stocks）
# =============================================================================
def _get_industry_stocks(industry_or_concept: str, date: str) -> List[str]:
    """
    行业 → 成分股。
    优先 get_concept_stocks（同花顺概念 / 申万行业共享接口）。
    返回 List[str]，失败时返回 []。
    """
    # 1) 概念接口（首选）
    try:
        stocks = get_concept_stocks(industry_or_concept, date=date)
        if stocks:
            return list(stocks)
    except Exception:
        pass
    # 2) 兼容部分：把 "sw_l2:801120" 这种格式拆开
    try:
        if ":" in str(industry_or_concept):
            code = industry_or_concept.split(":", 1)[1]
            stocks = get_concept_stocks(code, date=date)
            if stocks:
                return list(stocks)
    except Exception:
        pass
    return []



# =============================================================================
# 共用：过滤 + 基础工具
# =============================================================================
def filter_stock_universe(date: str, min_list_days: int = 180) -> List[str]:
    """所有 A 股 - ST - 停牌 - 上市不足 N 天"""
    dt_date = dt.datetime.strptime(date, "%Y-%m-%d")
    df = get_all_securities(types=["stock"], date=date)
    df = df[df["start_date"] < (dt_date - dt.timedelta(days=min_list_days)).date()]
    return list(df.index)


def stock_name_map(stocks: List[str]) -> Dict[str, str]:
    """代码 -> 名称"""
    out = {}
    for s in stocks:
        info = get_security_info(s)
        if info is not None:
            out[s] = info.display_name
    return out


# =============================================================================
# A1. 板块轮动打分（来自 02 notebook）
# =============================================================================
def calc_industry_score(
    industry: str,
    date: str,
    return_days: int = 5,
    change_limit_pct: float = 5.0,
) -> Tuple[int, List[Tuple[str, str, float]]]:
    """
    对单个行业计算"热度得分"
    score = 行业内超过涨幅阈值的股票数占比 × 涨幅均值 × 10
    返回: (score, [top_stocks])
    """
    stocks = _get_industry_stocks(industry, date)
    if not stocks or len(stocks) < 10:
        return 0, []

    df = get_price(
        stocks,
        end_date=date,
        frequency="daily",
        fields=["close"],
        fq="pre",
        count=return_days + 1,
        panel=False,
    )
    if df.empty:
        return 0, []

    pivot = df.pivot(index="time", columns="code", values="close")
    ret = (pivot.iloc[-1] / pivot.iloc[0]) - 1
    ret = ret.dropna()

    df_ok = ret[ret > change_limit_pct / 100]
    if len(df_ok) == 0 or len(ret) == 0:
        return 0, []

    mean = df_ok.mean() * 100
    score = int(len(df_ok) / len(ret) * mean * 10)

    top = ret.sort_values(ascending=False).head(5)
    top_stocks = [(s, "", float(v * 100)) for s, v in top.items()]
    return score, top_stocks


def section_score_top_industries(date: str, top_n: int = 10) -> str:
    """A1: 板块轮动打分（来自 02 notebook）"""
    out = ["## A1. 板块轮动打分（02 笔记本逻辑）\n"]
    out.append(f"参数: 5日涨幅 > 5%, sw_l2 行业\n")
    out.append("| 行业 | score | Top 5 个股（代码+涨幅） |")
    out.append("| --- | --- | --- |")

    industries = get_all_concepts()  # 申万二级
    rows = []
    for ind in industries.index[:50]:  # 限前 50 个避免超时
        score, top = calc_industry_score(ind, date)
        if score > 100:
            rows.append((ind, score, top))
    rows.sort(key=lambda x: x[1], reverse=True)
    for ind, score, top in rows[:top_n]:
        top_str = ", ".join([f"`{s}`(+{v:.1f}%)" for s, _, v in top])
        out.append(f"| {ind} | {score} | {top_str} |")
    return "\n".join(out) + "\n"


# =============================================================================
# A2. 板块动量趋势（来自 64 notebook）
# =============================================================================
def calc_momentum_one_window(
    date: str,
    statistics_days: int,
    growth_limit: float,
    stocks: List[str],
) -> Dict[str, float]:
    """
    单窗口动量 = count² / total
    count: 行业内涨幅超阈值的个股数
    total: 行业内总股票数
    """
    df = get_price(
        stocks,
        end_date=date,
        frequency="daily",
        fields=["close"],
        fq="pre",
        count=statistics_days + 1,
        panel=False,
    )
    if df.empty:
        return {}
    pivot = df.pivot(index="time", columns="code", values="close")
    ret = (pivot.iloc[-1] / pivot.iloc[-statistics_days]) - 1

    industry_map = get_stock_industry(stocks, date=date)
    ind_to_ret: Dict[str, pd.Series] = {}
    for s, v in ret.items():
        if pd.isna(v):
            continue
        ind = industry_map.get(s, "未知")
        ind_to_ret.setdefault(ind, pd.Series(dtype=float))[s] = v

    momentum: Dict[str, float] = {}
    for ind, series in ind_to_ret.items():
        count = int((series > growth_limit).sum())
        total = int(len(series))
        if total == 0:
            continue
        momentum[ind] = round(count * count / total, 2)
    return momentum


def section_momentum_top_industries(date: str) -> str:
    """A2: 板块动量趋势（来自 64 notebook）"""
    out = ["## A2. 板块动量趋势（64 笔记本逻辑）\n"]
    windows = [(1, 0.05), (3, 0.08), (5, 0.10), (10, 0.15), (20, 0.20)]
    out.append("| 窗口 | Top 6 板块（动量=count²/total） |")
    out.append("| --- | --- |")

    universe = filter_stock_universe(date)[:500]  # 限速
    for days, limit in windows:
        mom = calc_momentum_one_window(date, days, limit, universe)
        top = sorted(mom.items(), key=lambda x: x[1], reverse=True)[:6]
        top_str = ", ".join([f"{ind}={v:.1f}" for ind, v in top])
        out.append(f"| {days}日>{limit*100:.0f}% | {top_str} |")
    return "\n".join(out) + "\n"


# =============================================================================
# A3. 热点行业和热点概念-龙一龙二龙三（来自 98 notebook）
# =============================================================================
def calc_lead_stocks(category: str, date: str, watch_days: int = 7, top_n: int = 5) -> List[Tuple[str, float]]:
    """
    找概念内最近 watch_days 内涨幅最大的 top_n 个股
    （98 notebook 核心逻辑的简化版）
    """
    stocks = get_concept_stocks(category, date=date)
    if not stocks or len(stocks) < 5:
        return []

    df = get_price(
        stocks,
        end_date=date,
        frequency="daily",
        fields=["close"],
        fq="pre",
        count=watch_days + 1,
        panel=False,
    )
    if df.empty:
        return []
    pivot = df.pivot(index="time", columns="code", values="close")
    ret = (pivot.iloc[-1] / pivot.iloc[0]) - 1
    ret = ret.dropna().sort_values(ascending=False)
    return [(s, float(v * 100)) for s, v in ret.head(top_n).items()]


def section_concept_lead_stocks(date: str, categories: List[str] = None) -> str:
    """A3: 热点概念龙一龙二龙三（来自 98 notebook）"""
    out = ["## A3. 热点概念-龙一龙二龙三（98 笔记本逻辑）\n"]
    if categories is None:
        # 默认从 A1 取 Top 5 行业
        industries = get_all_concepts()
        categories = list(industries.index[:10])
    out.append("| 概念 | 龙一 | 龙二 | 龙三 | 龙头涨幅 |")
    out.append("| --- | --- | --- | --- | --- |")
    for cat in categories[:10]:
        leads = calc_lead_stocks(cat, date)
        if not leads:
            continue
        leads_str = ", ".join([f"`{s}`(+{v:.1f}%)" for s, v in leads[:3]])
        max_ret = leads[0][1] if leads else 0.0
        out.append(f"| {cat} | {leads_str} | {max_ret:+.1f}% |")
    return "\n".join(out) + "\n"


# =============================================================================
# A4. 行业情绪专题-净新高占比（来自 89 notebook）
# =============================================================================
def calc_industry_nhnl(industry: str, date: str, lookback_days: int = 250) -> float:
    """
    (NH-NL)% = (年度新高个股数 - 年度新低个股数) / 行业内总个股数
    范围: [-1, +1]
    """
    stocks = _get_industry_stocks(industry, date)
    if not stocks:
        return 0.0

    df = get_price(
        stocks,
        end_date=date,
        frequency="daily",
        fields=["high", "low"],
        fq="pre",
        count=lookback_days + 1,
        panel=False,
    )
    if df.empty:
        return 0.0

    # 年度新高 = 当日 high = 近 250 日最高
    pivot_high = df.pivot(index="time", columns="code", values="high")
    pivot_low = df.pivot(index="time", columns="code", values="low")
    today_high = pivot_high.iloc[-1]
    today_low = pivot_low.iloc[-1]
    max_250 = pivot_high.max()
    min_250 = pivot_low.min()
    new_high = (today_high >= max_250).sum()
    new_low = (today_low <= min_250).sum()
    total = pivot_high.shape[1]
    if total == 0:
        return 0.0
    return round((new_high - new_low) / total, 3)


def section_industry_nhnl_signal(date: str, top_n: int = 28) -> str:
    """A4: 行业情绪专题-净新高占比（来自 89 notebook）"""
    out = ["## A4. 行业净新高占比（89 笔记本逻辑）\n"]
    out.append("(NH-NL)%, 范围 [-1, +1].  > +0.5 顶部(减仓) / < -0.5 底部(加仓)\n")
    out.append("| 行业 | 净新高占比 | 信号 |")
    out.append("| --- | --- | --- |")

    industries = get_all_concepts()
    rows = []
    for ind in industries.index[:top_n]:
        nhnl = calc_industry_nhnl(ind, date)
        rows.append((ind, nhnl))
    rows.sort(key=lambda x: x[1], reverse=True)
    for ind, nhnl in rows:
        if nhnl > 0.5:
            signal = "🔴 顶部(减仓)"
        elif nhnl < -0.5:
            signal = "🟢 底部(加仓)"
        else:
            signal = "⚪ 中性"
        out.append(f"| {ind} | {nhnl:+.3f} | {signal} |")
    return "\n".join(out) + "\n"


# =============================================================================
# 合成日报
# =============================================================================
def render_daily_report(date: str) -> str:
    parts = [
        f"# 抓热点板块日报 — {date}\n",
        f"_基于 jk2bt + akshare 数据；4 个笔记本核心逻辑合一_\n",
        "---\n",
        section_score_top_industries(date),
        section_momentum_top_industries(date),
        section_concept_lead_stocks(date),
        section_industry_nhnl_signal(date),
        "---\n",
        "## 现在阶段结论\n",
        "- **A1 score > 1000** 的板块：强热门，考虑加仓\n",
        "- **A2 动量 count²/total > 5**：极强动量（少数股带飞）\n",
        "- **A3 龙头股 +10% 以上**：找龙一龙二龙三的具体标的\n",
        "- **A4 (NH-NL)% > +0.5 顶部减仓 / < -0.5 底部加仓**\n",
        "\n跑法: `python strategies/daily_hotspot_report.py --date YYYY-MM-DD`\n",
    ]
    return "\n".join(parts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="YYYY-MM-DD（默认最近一个交易日）")
    args = parser.parse_args()
    if args.date is None:
        args.date = get_previous_trade_date().strftime("%Y-%m-%d")
    print(render_daily_report(args.date))


if __name__ == "__main__":
    main()
