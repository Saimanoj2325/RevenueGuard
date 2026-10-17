"""Small asyncio circuit breaker (closed -> open -> half-open)."""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable


class CircuitOpenError(Exception):
    def __init__(self, name: str, retry_in: float):
        super().__init__(f"circuit '{name}' open; retry in {retry_in:.0f}s")
        self.name = name
        self.retry_in = retry_in


class CircuitBreaker:
    def __init__(self, name: str, fail_max: int = 3, reset_timeout: float = 30.0, exclude: tuple[type[BaseException], ...] = ()):
        self.name = name
        self.fail_max = fail_max
        self.reset_timeout = reset_timeout
        self.exclude = exclude
        self.failures = 0
        self.opened_at: float | None = None
        self._lock = asyncio.Lock()

    @property
    def state(self) -> str:
        if self.opened_at is None:
            return "closed"
        if time.monotonic() - self.opened_at >= self.reset_timeout:
            return "half_open"
        return "open"

    def reset(self) -> None:
        self.failures = 0
        self.opened_at = None

    def record_failure(self) -> None:
        self.failures += 1
        if self.failures >= self.fail_max:
            self.opened_at = time.monotonic()

    def record_success(self) -> None:
        self.failures = 0
        self.opened_at = None

    async def call(self, fn: Callable[[], Awaitable[Any]]) -> Any:
        st = self.state
        if st == "open":
            raise CircuitOpenError(self.name, self.reset_timeout - (time.monotonic() - (self.opened_at or 0)))
        try:
            result = await fn()
        except self.exclude:
            raise
        except Exception:
            self.record_failure()
            raise
        self.record_success()
        return result


_registry: dict[str, CircuitBreaker] = {}


def get_breaker(name: str, fail_max: int = 3, reset_timeout: float = 30.0) -> CircuitBreaker:
    if name not in _registry:
        _registry[name] = CircuitBreaker(name, fail_max, reset_timeout)
    return _registry[name]


def all_breakers() -> dict[str, str]:
    return {k: v.state for k, v in _registry.items()}
