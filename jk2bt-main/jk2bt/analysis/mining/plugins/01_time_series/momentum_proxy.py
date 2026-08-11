"""
momentum_proxy.py
动量因子插件（旧式，待迁移）。

这是一个旧式插件的示例，使用 @register_plugin 装饰器。
"""

import pandas as pd
import numpy as np


@register_plugin(
    "momentum_proxy",
    direction="01_time_series",
    period=20,
    description="动量代理因子（旧式实现）"
)
def produce(panel, period=20):
    """
    计算动量因子。
    
    Parameters
    ----------
    panel : object
        面板数据对象
    period : int
        回溯周期
        
    Returns
    -------
    pd.DataFrame
        动量因子值
    """
    # 模拟计算动量
    close = panel.column_wide("close") if hasattr(panel, 'column_wide') else None
    
    if close is not None:
        # 简单动量计算：当前价格 / N天前价格 - 1
        momentum = close.pct_change(period)
        return momentum
    
    # 返回模拟数据
    symbols = ["000001.XSHE", "000002.XSHE", "000004.XSHE"]
    dates = pd.date_range("2024-01-01", periods=10)
    data = np.random.randn(len(dates), len(symbols)) * 0.1
    return pd.DataFrame(data, index=dates, columns=symbols)
