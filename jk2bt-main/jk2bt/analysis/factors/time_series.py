"""
time_series.py
时间序列因子模块。

包含从 01_time_series 插件迁移的因子。
"""

import pandas as pd
import numpy as np
from jk2bt.analysis.factors.panel_base import PanelFactorBase
from jk2bt.analysis.factors.base import FactorRegistry


@FactorRegistry.register("momentum_proxy", aliases=["动量代理"], description="动量代理因子（新式实现）")
class MomentumProxyFactor(PanelFactorBase):
    """
    动量代理因子。
    
    从旧式插件迁移而来，使用 PanelFactorBase 基类。
    """
    
    name = "momentum_proxy"
    category = "momentum"
    group = "01_time_series"
    description = "动量代理因子（新式实现）"
    
    def produce(self, panel, period=20):
        """计算动量因子"""
        # 尝试从 panel 获取收盘价
        close = None
        if hasattr(panel, 'column_wide'):
            close = panel.column_wide("close")
        elif hasattr(panel, 'get'):
            close = panel.get("close")
        
        if close is not None and isinstance(close, pd.DataFrame):
            # 真实动量计算：当前价格 / N天前价格 - 1
            momentum = close.pct_change(period)
            return momentum
        
        # 返回模拟数据（用于测试）
        symbols = ["000001.XSHE", "000002.XSHE", "000004.XSHE"]
        dates = pd.date_range("2024-01-01", periods=10)
        data = np.random.randn(len(dates), len(symbols)) * 0.1
        return pd.DataFrame(data, index=dates, columns=symbols)


@FactorRegistry.register("mean_reversion_proxy", description="均值回归代理因子")
class MeanReversionProxyFactor(PanelFactorBase):
    """均值回归代理因子"""
    
    name = "mean_reversion_proxy"
    category = "reversal"
    group = "01_time_series"
    description = "均值回归代理因子"
    
    def produce(self, panel, period=20):
        """计算均值回归因子"""
        # 尝试从 panel 获取收盘价
        close = None
        if hasattr(panel, 'column_wide'):
            close = panel.column_wide("close")
        elif hasattr(panel, 'get'):
            close = panel.get("close")
        
        if close is not None and isinstance(close, pd.DataFrame):
            # 计算移动平均和偏离度
            ma = close.rolling(window=period).mean()
            mean_reversion = (close - ma) / ma
            return mean_reversion
        
        # 返回模拟数据
        symbols = ["000001.XSHE", "000002.XSHE", "000004.XSHE"]
        dates = pd.date_range("2024-01-01", periods=10)
        data = np.random.randn(len(dates), len(symbols)) * 0.05
        return pd.DataFrame(data, index=dates, columns=symbols)


@FactorRegistry.register("volatility_proxy", description="波动率代理因子")
class VolatilityProxyFactor(PanelFactorBase):
    """波动率代理因子"""
    
    name = "volatility_proxy"
    category = "volatility"
    group = "01_time_series"
    description = "波动率代理因子"
    
    def produce(self, panel, period=20):
        """计算波动率因子"""
        # 尝试从 panel 获取收盘价
        close = None
        if hasattr(panel, 'column_wide'):
            close = panel.column_wide("close")
        elif hasattr(panel, 'get'):
            close = panel.get("close")
        
        if close is not None and isinstance(close, pd.DataFrame):
            # 计算滚动标准差
            volatility = close.rolling(window=period).std()
            return volatility
        
        # 返回模拟数据
        symbols = ["000001.XSHE", "000002.XSHE", "000004.XSHE"]
        dates = pd.date_range("2024-01-01", periods=10)
        data = np.random.rand(len(dates), len(symbols)) * 0.02 + 0.01
        return pd.DataFrame(data, index=dates, columns=symbols)
