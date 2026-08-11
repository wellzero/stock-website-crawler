"""
mining 模块
因子挖掘和插件系统（迁移中）。

本模块提供因子挖掘功能，包括：
- 插件系统（已废弃，迁移到 FactorRegistry）
- 因子挖掘工具
- 模型集成接口
"""

from .plugin import (
    register_plugin,
    get_plugin,
    run_plugin,
    auto_discover,
    list_plugins,
)

__all__ = [
    "register_plugin",
    "get_plugin",
    "run_plugin", 
    "auto_discover",
    "list_plugins",
]
