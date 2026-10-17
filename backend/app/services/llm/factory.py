"""Provider chain with automatic failover (e.g. Gemini → Groq)."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from functools import lru_cache

from app.config import get_settings
from app.core.errors import LLMError
from app.services.llm.base import LLMProvider, ProviderError
from app.services.llm.mock import MockProvider
from app.services.llm.openai_compat import OpenAICompatProvider

log = logging.getLogger(__name__)


class ProviderChain:
    def __init__(self, providers: list[LLMProvider]):
        self.providers = providers

    @property
    def primary(self) -> LLMProvider | None:
        return self.providers[0] if self.providers else None

    def _ensure(self) -> None:
        if not self.providers:
            raise LLMError("No AI provider is configured on the server. Set GEMINI_API_KEY or GROQ_API_KEY.",
                           code="llm_not_configured", status_code=503)

    async def complete(self, messages: list[dict], *, json_mode: bool = False, temperature: float | None = None) -> tuple[str, LLMProvider]:
        self._ensure()
        errors = []
        for p in self.providers:
            try:
                return await p.complete(messages, json_mode=json_mode, temperature=temperature), p
            except ProviderError as exc:
                log.warning("provider %s failed: %s", p.name, exc)
                errors.append((p.name, exc))
        raise _as_llm_error(errors)

    async def stream(self, messages: list[dict], *, temperature: float | None = None) -> AsyncIterator[tuple[str, object]]:
        """Yields ("provider", LLMProvider) once, then ("delta", str) chunks.
        Fails over to the next provider only if nothing has been streamed yet."""
        self._ensure()
        errors = []
        for p in self.providers:
            started = False
            try:
                async for chunk in p.stream(messages, temperature=temperature):
                    if not started:
                        started = True
                        yield "provider", p
                    yield "delta", chunk
                if started:
                    return
                errors.append((p.name, ProviderError("empty stream", retryable=True)))
            except ProviderError as exc:
                log.warning("provider %s stream failed: %s", p.name, exc)
                if started:
                    raise LLMError("The AI provider dropped the connection mid-response. Please try again.",
                                   code="llm_stream_interrupted") from exc
                errors.append((p.name, exc))
        raise _as_llm_error(errors)


def _as_llm_error(errors: list[tuple[str, ProviderError]]) -> LLMError:
    statuses = {e.status for _, e in errors}
    detail = "; ".join(f"{n}: {e}" for n, e in errors)
    if statuses and statuses <= {429}:
        return LLMError("The AI service is busy right now (rate limit reached). Please wait a minute and try again.",
                        code="llm_rate_limited", status_code=503, details={"providers": detail})
    if statuses and statuses <= {401, 403}:
        return LLMError("The server's AI API key was rejected. Please contact the site owner.",
                        code="llm_auth", status_code=503, details={"providers": detail})
    return LLMError("The AI service is temporarily unavailable. Please try again in a moment.",
                    details={"providers": detail})


@lru_cache
def get_chain() -> ProviderChain:
    s = get_settings()
    common = dict(timeout=s.llm_timeout_seconds, max_retries=s.llm_max_retries,
                  temperature=s.llm_temperature, max_tokens=s.llm_max_output_tokens)
    providers: list[LLMProvider] = []
    for name in s.provider_chain:
        if name == "gemini" and s.gemini_api_key:
            extra = {"reasoning_effort": s.gemini_reasoning_effort} if s.gemini_reasoning_effort else {}
            providers.append(OpenAICompatProvider("gemini", s.gemini_api_key, s.gemini_model, s.gemini_base_url, extra=extra, **common))
        elif name == "groq" and s.groq_api_key:
            providers.append(OpenAICompatProvider("groq", s.groq_api_key, s.groq_model, s.groq_base_url, **common))
        elif name == "openai" and s.openai_api_key:
            providers.append(OpenAICompatProvider("openai", s.openai_api_key, s.openai_model, s.openai_base_url, **common))
        elif name == "ollama":
            providers.append(OpenAICompatProvider("ollama", "ollama", s.ollama_model, s.ollama_base_url,
                                                  **{**common, "timeout": max(common["timeout"], 240.0)}))
        elif name == "mock":
            providers.append(MockProvider(delay=0.0 if s.environment == "test" else 0.015))
    return ProviderChain(providers)
