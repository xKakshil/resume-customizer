"""Tiny in-memory sliding-window rate limiter for the expensive (LLM) endpoints.

Good enough for a single instance on a free tier; swap for Redis if the
backend is scaled horizontally.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock

from fastapi import Request

from app.config import get_settings
from app.core.errors import RateLimitedError

_hits: dict[str, deque[float]] = defaultdict(deque)
_lock = Lock()
WINDOW = 60.0


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check(request: Request, bucket: str = "llm", limit: int | None = None) -> None:
    limit = limit or get_settings().rate_limit_per_minute
    if limit <= 0:
        return
    key = f"{bucket}:{client_ip(request)}"
    now = time.monotonic()
    with _lock:
        q = _hits[key]
        while q and now - q[0] > WINDOW:
            q.popleft()
        if len(q) >= limit:
            retry = int(WINDOW - (now - q[0])) + 1
            raise RateLimitedError(f"Too many requests. Please wait {retry} seconds and try again.", details={"retry_after": retry})
        q.append(now)
        if len(_hits) > 10_000:  # bound memory
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > WINDOW][:5000]:
                _hits.pop(k, None)


def rate_limit_llm(request: Request) -> None:
    check(request, "llm")


def reset() -> None:
    with _lock:
        _hits.clear()
