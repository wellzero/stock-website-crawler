"""
factors 模块
聚宽因子库 → AkShare + Backtrader 本地计算兼容层。

职责：选股因子（连续值，打分排序）

模块结构：
- base.py          : 基础设施（别名映射、缓存、注册表）
- valuation.py     : 估值因子（market_cap, PE/PB/PS/PCF 等）
- technical.py     : 技术因子（BIAS, EMA, ROC, VOL, BOLL, ATR, RSI, KDJ 等）
- fundamentals.py  : 财务因子（ROE, ROA, RNOA, net_profit_ratio 等）
- financial_metrics.py: 聚宽indicator风格财务指标因子（eps, roe, roa, 增长率等）
- growth.py        : 成长因子（利润增速、营收增速等）
- quality.py       : 质量/杠杆因子（debt_to_assets, leverage 等）
- barra_factors.py : Barra风格因子（beta, momentum, residual_volatility, liquidity 等）
- custom_factors.py: 自定义因子函数（get_zscore, get_score 等）
- finance_tables.py: 聚宽风格财务数据表查询接口（finance.run_query）
- qlib_alpha.py    : Alpha101/Alpha191 因子（基于 qlib）
- factor_zoo.py    : 总入口，暴露 get_factor_values_jq
- preprocess.py    : 因子预处理（去极值、标准化、中性化）

命名规范：
- factors/ 用于选股因子（连续值，打分排序）
- signals/ 用于择时信号（离散事件，买卖触发）
- api/indicators.py 用于聚宽兼容技术指标API（MA/MACD/KDJ等）
"""

from .base import (
    normalize_factor_name,
    normalize_factor_names,
    global_factor_registry,
    FactorRegistry,
)
from .panel_base import PanelFactorBase
from .registry_extensions import add_registry_extensions

# 应用注册表扩展
add_registry_extensions()

from .constants import (
    CNE6_STYLE_FACTORS,
    FACTOR_LIBRARY,
    FACTOR_IC_BASE,
)

from .zoo import get_factor_values_jq
from .preprocess import winsorize_med, standardlize, neutralize
from .finance_tables import finance, FinanceTable

try:
    from .risk import (
        get_factor_cov,
        get_factor_variance,
        get_factor_correlation,
        factor_risk_analysis,
        portfolio_factor_risk,
        rolling_factor_cov,
        eigenvalue_decomposition,
    )

    RISK_AVAILABLE = True
except ImportError:
    RISK_AVAILABLE = False

try:
    from .qlib_alpha import (
        init_qlib,
        compute_alpha101,
        compute_alpha191,
        compute_alpha360,
        get_alpha_values_jq,
    )

    QLIB_ALPHA_AVAILABLE = True
except ImportError:
    QLIB_ALPHA_AVAILABLE = False

from . import (
    valuation,
    technical,
    fundamentals,
    financial_metrics,  # 重命名自 indicators
    growth,
    quality,
    barra,
    custom,
    finance_tables,
)

# 兼容性别名（已弃用，请直接使用 financial_metrics）
import warnings as _warnings


class _DeprecatedIndicatorsModule:
    def __init__(self, real_module):
        self._real = real_module

    def __getattr__(self, name):
        _warnings.warn(
            "factors.indicators is deprecated, use factors.financial_metrics instead",
            DeprecationWarning,
            stacklevel=2,
        )
        return getattr(self._real, name)


indicators = _DeprecatedIndicatorsModule(financial_metrics)

__all__ = [
    "get_factor_values_jq",
    "winsorize_med",
    "standardlize",
    "neutralize",
    "normalize_factor_name",
    "normalize_factor_names",
    "global_factor_registry",
    "FactorRegistry",
    "finance",
    "FinanceTable",
    "valuation",
    "technical",
    "fundamentals",
    "financial_metrics",
    "indicators",  # 兼容性别名
    "growth",
    "quality",
    "barra",
    "custom",
    "finance_tables",
    "CNE6_STYLE_FACTORS",
    "FACTOR_LIBRARY",
    "FACTOR_IC_BASE",
]

if RISK_AVAILABLE:
    __all__.extend(
        [
            "get_factor_cov",
            "get_factor_variance",
            "get_factor_correlation",
            "factor_risk_analysis",
            "portfolio_factor_risk",
            "rolling_factor_cov",
            "eigenvalue_decomposition",
        ]
    )

if QLIB_ALPHA_AVAILABLE:
    __all__.extend(
        [
            "init_qlib",
            "compute_alpha101",
            "compute_alpha191",
            "compute_alpha360",
            "get_alpha_values_jq",
        ]
    )

# 导入时间序列因子模块
from . import time_series
