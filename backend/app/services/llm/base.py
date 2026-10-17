from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator


class ProviderError(Exception):
    """Raised by a provider. `retryable` errors (429, 5xx, timeouts) may succeed
    on retry or on the next provider; non-retryable ones (bad key) skip straight
    to the next provider."""

    def __init__(self, message: str, *, retryable: bool, status: int | None = None, retry_after: float | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.retry_after = retry_after


class LLMProvider(ABC):
    name: str = "base"
    model: str = ""

    @abstractmethod
    async def complete(self, messages: list[dict], *, json_mode: bool = False, temperature: float | None = None) -> str: ...

    @abstractmethod
    def stream(self, messages: list[dict], *, temperature: float | None = None) -> AsyncIterator[str]: ...
