"""One client for every OpenAI-compatible Chat Completions API.

Gemini (via Google's OpenAI-compatible endpoint), Groq and OpenAI all speak the
same wire protocol, so a single small httpx client covers all three with no
vendor SDKs. It handles retries with exponential backoff + jitter, honours
Retry-After, and parses server-sent events for streaming.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from collections.abc import AsyncIterator

import httpx

from app.services.llm.base import LLMProvider, ProviderError

log = logging.getLogger(__name__)


class OpenAICompatProvider(LLMProvider):
    def __init__(self, name: str, api_key: str, model: str, base_url: str, *, timeout: float, max_retries: int,
                 temperature: float, max_tokens: int, extra: dict | None = None):
        self.name = name
        self._extra = dict(extra or {})  # provider-specific params, e.g. reasoning_effort
        self.model = model
        self._key = api_key
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._timeout = httpx.Timeout(timeout, connect=10.0)
        self._retries = max_retries
        self._temperature = temperature
        self._max_tokens = max_tokens

    # ------------------------------------------------------------------ #
    def _payload(self, messages: list[dict], *, json_mode: bool, stream: bool, temperature: float | None) -> dict:
        body = {
            "model": self.model,
            "messages": messages,
            "temperature": self._temperature if temperature is None else temperature,
            "max_tokens": self._max_tokens,
            "stream": stream,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        body.update(self._extra)
        return body

    def _maybe_drop_unsupported(self, status: int, text: str) -> bool:
        """If the endpoint rejected an optional extra param, drop it and allow a retry."""
        if status != 400:
            return False
        dropped = [k for k in self._extra if k in text]
        for k in dropped:
            self._extra.pop(k, None)
        return bool(dropped)

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}

    @staticmethod
    def _error_from_response(resp: httpx.Response, body: str) -> ProviderError:
        status = resp.status_code
        retry_after = None
        if ra := resp.headers.get("retry-after"):
            try:
                retry_after = float(ra)
            except ValueError:
                pass
        if retry_after is None and (m := re.search(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"', body)):
            retry_after = float(m.group(1))  # Google APIs put the wait in the body, not a header
        snippet = body[:300].replace("\n", " ")
        if status in (401, 403):
            return ProviderError(f"authentication failed ({status})", retryable=False, status=status)
        if status == 429:
            return ProviderError("rate limited by provider", retryable=True, status=status, retry_after=retry_after)
        if status >= 500:
            return ProviderError(f"provider server error ({status})", retryable=True, status=status, retry_after=retry_after)
        return ProviderError(f"request rejected ({status}): {snippet}", retryable=False, status=status)

    @staticmethod
    def _wait_too_long(err: ProviderError) -> bool:
        """The provider asked us to wait longer than is worth it: hand over to the next one now."""
        return (err.retry_after or 0) > 10

    async def _backoff(self, attempt: int, err: ProviderError) -> None:
        delay = err.retry_after if err.retry_after is not None else min(8.0, 0.8 * 2**attempt) + random.uniform(0, 0.4)
        await asyncio.sleep(min(delay, 10.0))

    # ------------------------------------------------------------------ #
    async def complete(self, messages: list[dict], *, json_mode: bool = False, temperature: float | None = None) -> str:
        use_json_mode = json_mode
        last: ProviderError | None = None
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            for attempt in range(self._retries + 1):
                try:
                    resp = await client.post(self._url, headers=self._headers(),
                                             json=self._payload(messages, json_mode=use_json_mode, stream=False, temperature=temperature))
                except (httpx.TimeoutException, httpx.TransportError) as exc:
                    last = ProviderError(f"network error: {type(exc).__name__}", retryable=True)
                else:
                    if resp.status_code == 200:
                        try:
                            data = resp.json()
                            choice = data["choices"][0]
                            content = choice["message"].get("content") or ""
                        except (ValueError, KeyError, IndexError, TypeError) as exc:
                            raise ProviderError("malformed response from provider", retryable=True) from exc
                        if not content.strip():
                            reason = choice.get("finish_reason")
                            last = ProviderError(f"empty response (finish_reason={reason})", retryable=True)
                        else:
                            return content
                    else:
                        last = self._error_from_response(resp, resp.text)
                        # Some OpenAI-compatible endpoints don't support response_format; retry once without it.
                        if resp.status_code == 400 and use_json_mode and "response_format" in resp.text:
                            use_json_mode = False
                            continue
                        if self._maybe_drop_unsupported(resp.status_code, resp.text):
                            continue
                if not last.retryable or attempt == self._retries or self._wait_too_long(last):
                    break
                log.warning("%s attempt %d failed: %s", self.name, attempt + 1, last)
                await self._backoff(attempt, last)
        assert last is not None
        raise last

    async def stream(self, messages: list[dict], *, temperature: float | None = None) -> AsyncIterator[str]:
        last: ProviderError | None = None
        for attempt in range(self._retries + 1):
            emitted = False
            try:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    async with client.stream("POST", self._url, headers=self._headers(),
                                             json=self._payload(messages, json_mode=False, stream=True, temperature=temperature)) as resp:
                        if resp.status_code != 200:
                            body = (await resp.aread()).decode("utf-8", "replace")
                            if self._maybe_drop_unsupported(resp.status_code, body):
                                raise ProviderError("retrying without unsupported parameter", retryable=True)
                            raise self._error_from_response(resp, body)
                        async for line in resp.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            data = line[5:].strip()
                            if data == "[DONE]":
                                return
                            try:
                                chunk = json.loads(data)
                            except json.JSONDecodeError:
                                continue
                            if err := chunk.get("error"):
                                raise ProviderError(f"stream error: {str(err)[:200]}", retryable=not emitted)
                            choices = chunk.get("choices") or []
                            if not choices:
                                continue
                            delta = (choices[0].get("delta") or {}).get("content")
                            if delta:
                                emitted = True
                                yield delta
                        return
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last = ProviderError(f"network error: {type(exc).__name__}", retryable=not emitted)
            except ProviderError as exc:
                last = exc
            # Once tokens have reached the client we can't transparently retry.
            if emitted:
                last.retryable = False
                raise last
            if not last.retryable or attempt == self._retries or self._wait_too_long(last):
                raise last
            log.warning("%s stream attempt %d failed: %s", self.name, attempt + 1, last)
            await self._backoff(attempt, last)
