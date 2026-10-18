"""Failover between AI providers when the primary is rate limited."""

import asyncio

import httpx

from app.services.llm.base import LLMProvider, ProviderError
from app.services.llm.factory import ProviderChain
from app.services.llm.openai_compat import OpenAICompatProvider


class Fake(LLMProvider):
    def __init__(self, name, fail_with=None):
        self.name, self.model, self.fail_with, self.calls = name, name, fail_with, 0

    async def complete(self, messages, *, json_mode=False, temperature=None):
        self.calls += 1
        if self.fail_with:
            raise self.fail_with
        return f"from {self.name}"

    async def stream(self, messages, *, temperature=None):
        self.calls += 1
        if self.fail_with:
            raise self.fail_with
        yield f"from {self.name}"


def test_rate_limited_provider_is_skipped_until_its_cooldown_ends():
    gemini = Fake("gemini", ProviderError("rate limited", retryable=True, status=429, retry_after=40))
    groq = Fake("groq")
    chain = ProviderChain([gemini, groq])
    assert asyncio.run(chain.complete([]))[0] == "from groq"
    assert asyncio.run(chain.complete([]))[0] == "from groq"
    assert gemini.calls == 1 and groq.calls == 2  # second request went straight to the fallback
    chain._cooldown["gemini"] = 0  # cooldown over
    gemini.fail_with = None
    assert asyncio.run(chain.complete([]))[0] == "from gemini"


def test_streaming_fails_over_and_all_cooling_still_tries():
    gemini = Fake("gemini", ProviderError("rate limited", retryable=True, status=429))
    groq = Fake("groq", ProviderError("rate limited", retryable=True, status=429))
    chain = ProviderChain([gemini, groq])

    async def run():
        return [x async for x in chain.stream([])]
    try:
        asyncio.run(run())
    except Exception as e:
        assert "busy" in str(e)
    groq.fail_with = None
    out = asyncio.run(run())  # both cooling down: they're still tried rather than failing outright
    assert ("delta", "from groq") in out


def test_google_retry_delay_in_body_hands_over_without_long_waits():
    calls = {"n": 0}
    body = '{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}'

    def handler(request):
        calls["n"] += 1
        return httpx.Response(429, text=body)
    p = OpenAICompatProvider("gemini", "k", "m", "https://x.test/v1", timeout=5, max_retries=2, temperature=0.2, max_tokens=100)
    real = httpx.AsyncClient
    httpx.AsyncClient = lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    try:
        asyncio.run(p.complete([{"role": "user", "content": "hi"}]))
    except ProviderError as e:
        assert e.status == 429 and e.retry_after == 37
    finally:
        httpx.AsyncClient = real
    assert calls["n"] == 1  # no pointless retries into a 37 s limit
