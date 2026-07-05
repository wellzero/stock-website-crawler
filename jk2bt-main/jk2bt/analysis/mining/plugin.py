"""
plugin.py
插件系统模块 - 桥接到 FactorRegistry。

提供：
- register_plugin: 插件注册装饰器（已废弃，向后兼容）
- get_plugin: 获取插件（已废弃，向后兼容）
- run_plugin: 运行插件（已废弃，向后兼容）
- auto_discover: 自动发现插件（已废弃，向后兼容）
"""

import warnings
from typing import Any, Callable, Dict, Optional
from dataclasses import dataclass


@dataclass
class _PluginEntry:
    """插件条目数据结构"""
    fn: Callable
    name: str
    direction: str = ""
    description: str = ""
    params: Dict[str, Any] = None


# 全局插件注册表（已废弃）
_PLUGINS: Dict[str, _PluginEntry] = {}


def register_plugin(
    name: str,
    direction: str = "",
    description: str = "",
    **default_params
):
    """
    ⚠️ 已废弃：请改用 @FactorRegistry.register + PanelFactorBase
    
    这个装饰器用于向后兼容旧的插件系统。
    新代码应该使用 @FactorRegistry.register 装饰器和 PanelFactorBase 基类。

    示例（旧方式）：
        @register_plugin("my_plugin", direction="01_time_series", description="...")
        def produce(panel, fast=5, slow=20):
            ...

    示例（新方式）：
        @FactorRegistry.register("my_plugin", description="...")
        class MyPlugin(PanelFactorBase):
            name = "my_plugin"
            group = "01_time_series"
            description = "..."
            
            def produce(self, panel, fast=5, slow=20):
                ...
    """
    warnings.warn(
        "register_plugin 已废弃，请改用 @FactorRegistry.register + PanelFactorBase",
        DeprecationWarning,
        stacklevel=2
    )
    
    def deco(fn):
        from jk2bt.analysis.factors import PanelFactorBase, global_factor_registry
        
        # 1. 动态创建 PanelFactorBase 子类
        category = direction.split("_", 1)[-1] if direction else "default"  # "01_time_series" -> "time_series"
        methods = {
            "name": name,
            "category": category,
            "group": direction,
            "description": description,
        }
        
        def produce(self, panel, **kw):  # noqa: ARG002 (兼容 PanelFactorBase 接口)
            merged = {**default_params, **kw}
            return fn(panel, **merged)
        
        methods["produce"] = produce
        
        factor_cls = type(f"{name}_Deprecated", (PanelFactorBase,), methods)
        global_factor_registry.register_class(name, factor_cls, description=description)
        
        # 2. 保留 _PLUGINS 向后兼容（标记为已废弃）
        old_entry = _PluginEntry(
            fn=fn, 
            name=name, 
            direction=direction,
            description=description, 
            params=default_params
        )
        _PLUGINS[name] = old_entry
        
        return fn
    
    return deco


def get_plugin(name: str) -> Optional[_PluginEntry]:
    """
    ⚠️ 已废弃：请改用 FactorRegistry.get()
    
    获取插件条目。
    """
    warnings.warn(
        "get_plugin 已废弃，请改用 FactorRegistry.get()",
        DeprecationWarning,
        stacklevel=2
    )
    return _PLUGINS.get(name)


def run_plugin(name: str, panel_view: Any, **kwargs) -> Any:
    """
    ⚠️ 已废弃：请改用 FactorRegistry.get().compute_batch()
    
    运行插件。
    
    替代方案：
        factor = FactorRegistry.get(name)
        result = factor().produce(panel_view, **kwargs)
    """
    warnings.warn(
        "run_plugin 已废弃，请改用 FactorRegistry.get().compute_batch()",
        DeprecationWarning,
        stacklevel=2
    )
    
    from jk2bt.analysis.factors import global_factor_registry
    
    # 尝试从 FactorRegistry 获取
    factor_class = global_factor_registry.get(name)
    if factor_class and hasattr(factor_class, 'produce'):
        factor_instance = factor_class()
        return factor_instance.produce(panel_view, **kwargs)
    
    # 降级到 _PLUGINS
    entry = _PLUGINS.get(name)
    if entry:
        merged_params = {**entry.params, **kwargs}
        return entry.fn(panel_view, **merged_params)
    
    raise ValueError(f"插件不存在: {name}")


def auto_discover(directory: str) -> int:
    """
    ⚠️ 已废弃：请改用 FactorRegistry.auto_discover()
    
    自动发现并注册插件。
    """
    warnings.warn(
        "auto_discover 已废弃，请改用 FactorRegistry.auto_discover()",
        DeprecationWarning,
        stacklevel=2
    )
    
    from jk2bt.analysis.factors import FactorRegistry
    return FactorRegistry.auto_discover(directory)


def list_plugins() -> list:
    """
    ⚠️ 已废弃：请改用 FactorRegistry.list_factors()
    
    列出所有插件。
    """
    warnings.warn(
        "list_plugins 已废弃，请改用 FactorRegistry.list_factors()",
        DeprecationWarning,
        stacklevel=2
    )
    
    from jk2bt.analysis.factors import global_factor_registry
    return global_factor_registry.list_factors()


def _try_import_variants(module_name: str) -> bool:
    """
    尝试多种导入变体。
    
    Parameters
    ----------
    module_name : str
        模块名称
        
    Returns
    -------
    bool
        是否导入成功
    """
    import importlib
    
    try:
        importlib.import_module(module_name)
        return True
    except ImportError:
        # 尝试其他变体
        variants = [
            module_name,
            module_name.replace("_", ""),
            f"jk2bt.{module_name}",
            f"analysis_v2.{module_name}",
        ]
        
        for variant in variants:
            try:
                importlib.import_module(variant)
                return True
            except ImportError:
                continue
    
    return False


__all__ = [
    "register_plugin",
    "get_plugin", 
    "run_plugin",
    "auto_discover",
    "list_plugins",
]
