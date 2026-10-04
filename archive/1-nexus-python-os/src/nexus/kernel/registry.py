"""A generic name -> object registry.

Tools, agents, and connectors all register here so higher layers can look them
up by name without hard imports. This is the mechanism that makes Nexus
extensible "by configuration": load a spec, resolve its tools from the registry.
"""

from __future__ import annotations

from typing import Generic, TypeVar

T = TypeVar("T")


class Registry(Generic[T]):
    def __init__(self, label: str = "item") -> None:
        self._label = label
        self._items: dict[str, T] = {}

    def register(self, name: str, item: T, *, overwrite: bool = False) -> T:
        if name in self._items and not overwrite:
            raise ValueError(f"{self._label} '{name}' is already registered")
        self._items[name] = item
        return item

    def get(self, name: str) -> T:
        try:
            return self._items[name]
        except KeyError:
            raise KeyError(f"unknown {self._label}: '{name}'") from None

    def try_get(self, name: str) -> T | None:
        return self._items.get(name)

    def has(self, name: str) -> bool:
        return name in self._items

    def names(self) -> list[str]:
        return sorted(self._items)

    def all(self) -> dict[str, T]:
        return dict(self._items)

    def __len__(self) -> int:
        return len(self._items)

    def __contains__(self, name: object) -> bool:
        return name in self._items
