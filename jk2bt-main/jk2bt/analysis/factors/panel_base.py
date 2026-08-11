"""
panel_base.py
全截面计算因子基类模块。

提供：
- PanelFactorBase：全截面计算因子基类
- 适配 produce(panel) 范式的插件迁移
"""

import inspect
import warnings
from typing import Any, Optional, Type
import pandas as pd


class PanelFactorBase:
    """
    全截面计算因子基类 — 适配 produce(panel) 范式。

    子类只需覆写 produce()，继承 compute()/compute_batch()。

    Parameters
    ----------
    data_source : optional
        数据源，传给 PanelContext 用于加载 OHLCV 等。
        如果为 None，compute()/compute_batch() 仍会尝试构建空的 panel 对象。
    """

    name: str = ""
    category: str = ""
    group: str = ""
    description: str = ""
    detail: str = ""
    aliases: list = []
    cross_sectional: bool = True
    phase: int = 1
    data_source: Any = None

    def __init__(self, data_source=None):
        if data_source is not None:
            self.data_source = data_source

    @property
    def params(self) -> dict[str, Any]:
        """从 produce 签名推断可调参数。"""
        produce_sig = inspect.signature(self.produce)
        params = {}
        for name, param in produce_sig.parameters.items():
            if name == 'panel':
                continue
            if param.default != inspect.Parameter.empty:
                params[name] = param.default
            else:
                params[name] = None
        return params

    def produce(self, panel: Any, **kwargs) -> Optional[pd.DataFrame]:
        """子类覆写此方法。"""
        raise NotImplementedError("子类必须实现 produce 方法")

    # ---------- 单只接口 ----------

    def compute(self, symbol, end_date=None, **kwargs):
        """
        单只股票计算。

        Parameters 与 compute_batch 中同名参数一致。
        额外接受 _ctx : PanelContext, optional 由 pipeline 传入。
        """
        _ctx = kwargs.pop('_ctx', None)
        df = self.compute_batch([symbol], end_date, _ctx=_ctx, **kwargs)
        if symbol in df.columns:
            return df[symbol]
        return pd.Series(dtype=float)

    # ---------- 批量接口 ----------

    def compute_batch(self, symbols, end_date=None, _ctx=None, **kwargs):
        """
        批量计算。

        签名兼容 pipeline 的 _ctx 检测机制：
          '_ctx' in inspect.signature(factor.compute_batch).parameters

        Parameters
        ----------
        symbols : list of str
        end_date : str, optional
        _ctx : PanelContext, optional
            由 pipeline 传入的共享面板上下文。
        **kwargs
            其他参数（如周期参数）。
        """
        # 如果 pipeline 传入了 _ctx，用它构建 panel
        if _ctx is not None:
            try:
                return self._produce_from_ctx(_ctx, **kwargs)
            except Exception as e:
                warnings.warn(f"PanelFactorBase._produce_from_ctx 出错: {e}")
                return pd.DataFrame()

        # 无 _ctx 时：尝试通过 controllib 构造 panel
        try:
            from jk2bt.analysis.mining.controllib import panel
            p = panel(symbols=symbols, end_date=end_date, data_source=self.data_source)
            result = self.produce(p, **kwargs)
            return result if result is not None else pd.DataFrame()
        except ImportError:
            warnings.warn("mining.controllib.panel 不可用，返回空 DataFrame")
            return pd.DataFrame()
        except Exception as e:
            warnings.warn(f"compute_batch 出错: {e}")
            return pd.DataFrame()

    def _produce_from_ctx(self, ctx, **kwargs):
        """
        从 panel 上下文对象构造 panel 并调用 produce()。
        子类可覆写以定制上下文 → produce 的映射逻辑。
        """
        try:
            from jk2bt.analysis.mining.controllib import panel as make_panel
            p = make_panel(
                symbols=list(ctx.universe) if ctx.universe else [],
                end_date=ctx.end_date,
                data_source=ctx.data_source or self.data_source,
            )
        except ImportError:
            # 没有 controllib 时直接用 ctx 本身作为 panel
            p = ctx

        result = self.produce(p, **kwargs)
        return result if result is not None else pd.DataFrame()
