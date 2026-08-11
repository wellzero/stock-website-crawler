"""
registry_extensions.py
因子注册表扩展模块。

为 FactorRegistry 添加支持 PanelFactorBase 和自动发现的功能。
"""

import os
import importlib.util
import sys
from pathlib import Path
from typing import Optional
import warnings

# 保存原始的导入以避免循环依赖
_normalize_factor_name = None
_global_factor_registry = None


def get_normalize_factor_name():
    """延迟获取 normalize_factor_name 函数"""
    global _normalize_factor_name
    if _normalize_factor_name is None:
        from jk2bt.analysis.factors.base import normalize_factor_name
        _normalize_factor_name = normalize_factor_name
    return _normalize_factor_name


def get_global_factor_registry():
    """延迟获取 global_factor_registry"""
    global _global_factor_registry
    if _global_factor_registry is None:
        from jk2bt.analysis.factors.base import global_factor_registry
        _global_factor_registry = global_factor_registry
    return _global_factor_registry


def add_registry_extensions():
    """
    为 FactorRegistry 类添加扩展方法。

    添加的方法：
    - auto_discover(): 自动扫描目录并注册因子
    - register_class(): 注册因子类
    """
    from jk2bt.analysis.factors.base import FactorRegistry

    # 保存原始的 register 方法（在替换之前）
    if not hasattr(FactorRegistry, '_original_register'):
        FactorRegistry._original_register = FactorRegistry.register

    @classmethod
    def auto_discover(cls, directory: str) -> int:
        """
        扫描目录树，导入 .py 文件，触发 @FactorRegistry.register 装饰器。

        Parameters
        ----------
        directory : str
            要扫描的目录路径

        Returns
        -------
        int
            成功导入的模块数量
        """
        count = 0
        directory_path = Path(directory)

        if not directory_path.exists():
            warnings.warn(f"目录不存在: {directory}")
            return 0

        # 递归查找所有 .py 文件
        for py_file in directory_path.rglob("*.py"):
            # 跳过 __pycache__ 和 __init__.py
            if "__pycache__" in str(py_file) or py_file.name == "__init__.py":
                continue

            try:
                # 构建模块路径
                module_path = py_file.relative_to(directory_path.parent)
                module_name = str(module_path.with_suffix("")).replace(os.sep, ".")

                # 动态导入模块
                spec = importlib.util.spec_from_file_location(module_name, py_file)
                if spec and spec.loader:
                    module = importlib.util.module_from_spec(spec)
                    sys.modules[module_name] = module
                    spec.loader.exec_module(module)
                    count += 1
            except Exception as e:
                warnings.warn(f"导入模块 {py_file} 失败: {e}")
                continue

        return count

    def register_class(
        self,
        name: str,
        factor_class: type,
        aliases: Optional[list] = None,
        description: str = "",
    ) -> None:
        """
        注册因子类（支持 PanelFactorBase）。

        Parameters
        ----------
        name : str
            因子规范名
        factor_class : type
            因子类
        aliases : list, optional
            别名列表
        description : str
            因子说明
        """
        normalize_factor_name = get_normalize_factor_name()
        norm_name = normalize_factor_name(name)
        self._factors[norm_name] = factor_class

        # 注册别名
        if aliases:
            for alias in aliases:
                alias_norm = normalize_factor_name(alias)
                self._factors[alias_norm] = factor_class

        self._metadata[norm_name] = {
            "type": "class",
            "description": description,
            "aliases": aliases or [],
        }

    # 添加新方法到 FactorRegistry 类
    FactorRegistry.auto_discover = auto_discover
    FactorRegistry.register_class = register_class

    def enhanced_register(*args, **kwargs):
        """
        增强的注册方法，向后兼容原有的函数注册模式，同时支持类注册。

        原有模式（函数）：
            registry.register('pe_ratio', compute_pe_ratio)

        新模式（类装饰器）：
            @FactorRegistry.register("my_factor", description="...")
            class MyFactor(PanelFactorBase):
                ...

        新模式（直接调用）：
            FactorRegistry.register("my_factor", MyFactor, description="...")
        """
        global_registry = get_global_factor_registry()

        # 处理装饰器模式: @FactorRegistry.register("name", ...)
        if len(args) == 1 and isinstance(args[0], str):
            name = args[0]
            # 返回装饰器
            def decorator(cls):
                # 如果是 PanelFactorBase 子类，使用 register_class
                if hasattr(cls, 'produce'):
                    global_registry.register_class(name, cls, **kwargs)
                else:
                    # 否则使用原始注册方式（兼容旧的函数注册）
                    FactorRegistry._original_register(global_registry, name, cls, **kwargs)
                return cls
            return decorator

        # 处理直接调用模式（至少2个参数）
        if len(args) >= 2:
            first_arg = args[0]
            # 检查第一个参数是否为 FactorRegistry 实例
            if hasattr(first_arg, '_factors') and hasattr(first_arg, 'register_class'):
                self, name, func = first_arg, args[1], args[2] if len(args) > 2 else None
                # 判断是否为类注册
                if func is not None and hasattr(func, 'produce'):
                    # PanelFactorBase 子类
                    self.register_class(name, func, **kwargs)
                    return None
                else:
                    # 使用原始注册方式（兼容旧的函数注册）
                    return FactorRegistry._original_register(self, name, func, **kwargs)
            else:
                # 可能是直接调用 FactorRegistry.register("name", func)
                name, func = args[0], args[1]
                if hasattr(func, 'produce'):
                    global_registry.register_class(name, func, **kwargs)
                    return None
                else:
                    return FactorRegistry._original_register(global_registry, name, func, **kwargs)

        # 其他情况，使用原始注册方式
        return FactorRegistry._original_register(*args, **kwargs)

    FactorRegistry.register = enhanced_register


# 自动应用扩展
add_registry_extensions()
