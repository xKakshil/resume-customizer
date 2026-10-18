"""Provider chain with automatic failover (e.g. Gemini → Groq)."""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator
from functools import lru_cache

from app.config import get_settings
from app.core.errors import LLMError
from app.services.llm.base import LLMProvider, ProviderError
from app.services.llm.mock import MockProvider
from app.services.llm.openai_compat import OpenAICompatProvider

log = logging.getLogger(__name__)


COOLDOWN_DEFAULT_S = 30.0
COOLDOWN_MAX_S = 300.0


class ProviderChain:
    """Tries providers in order. A provider that just hit its rate limit is skipped
    for a while (its Retry-After, else 30 s), so requests on a free-tier key go
    straight to the fallback instead of retrying into the same limit each time."""

    def __init__(self, providers: list[LLMProvider]):
        self.providers = providers
        self._cooldown: dict[str, float] = {}

    def _ordered(self) -> list[LLMProvider]:
        now = time.monotonic()
        ready = [p for p in self.providers if self._cooldown.get(p.name, 0) <= now]
        # If every provider is cooling down, try them all anyway (best chance first).
        return ready or sorted(self.providers, key=lambda p: self._cooldown.get(p.name, 0))

    def _note_failure(self, p: LLMProvider, exc: ProviderError) -> None:
        if exc.status == 429:
            wait = min(COOLDOWN_MAX_S, max(exc.retry_after or 0, COOLDOWN_DEFAULT_S))
            self._cooldown[p.name] = time.monotonic() + wait
            log.info("provider %s rate limited; skipping it for %.0fs", p.name, wait)

    def _note_success(self, p: LLMProvider) -> None:
        self._cooldown.pop(p.name, None)

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
        for p in self._ordered():
            try:
                out = await p.complete(messages, json_mode=json_mode, temperature=temperature)
                self._note_success(p)
                return out, p
            except ProviderError as exc:
                log.warning("provider %s failed: %s", p.name, exc)
                self._note_failure(p, exc)
                errors.append((p.name, exc))
        raise _as_llm_error(errors)

    async def stream(self, messages: list[dict], *, temperature: float | None = None) -> AsyncIterator[tuple[str, object]]:
        """Yields ("provider", LLMProvider) once, then ("delta", str) chunks.
        Fails over to the next provider only if nothing has been streamed yet."""
        self._ensure()
        errors = []
        for p in self._ordered():
            started = False
            try:
                async for chunk in p.stream(messages, temperature=temperature):
                    if not started:
                        started = True
                        yield "provider", p
                    yield "delta", chunk
                if started:
                    self._note_success(p)
                    return
                errors.append((p.name, ProviderError("empty stream", retryable=True)))
            except ProviderError as exc:
                log.warning("provider %s stream failed: %s", p.name, exc)
                self._note_failure(p, exc)
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
            reasoning = s.groq_reasoning_effort and "gpt-oss" in s.groq_model
            extra = {"reasoning_effort": s.groq_reasoning_effort} if reasoning else {}
            providers.append(OpenAICompatProvider("groq", s.groq_api_key, s.groq_model, s.groq_base_url, extra=extra, **common))
        elif name == "openai" and s.openai_api_key:
            providers.append(OpenAICompatProvider("openai", s.openai_api_key, s.openai_model, s.openai_base_url, **common))
        elif name == "ollama":
            providers.append(OpenAICompatProvider("ollama", "ollama", s.ollama_model, s.ollama_base_url,
                                                  **{**common, "timeout": max(common["timeout"], 240.0)}))
        elif name == "mock":
            providers.append(MockProvider(delay=0.0 if s.environment == "test" else 0.015))
    return ProviderChain(providers)
