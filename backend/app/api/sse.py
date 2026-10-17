"""Server-Sent Events helpers with keep-alive pings and error events."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator

from fastapi.responses import StreamingResponse

from app.core.errors import AppError

log = logging.getLogger(__name__)
PING_SECONDS = 10.0


def format_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _with_keepalive(source: AsyncIterator[tuple[str, dict]]) -> AsyncIterator[str]:
    """Interleave `: ping` comments so proxies (Render, Vercel, Cloudflare) don't
    close the connection while the model is still thinking."""
    queue: asyncio.Queue = asyncio.Queue()
    DONE = object()

    async def pump():
        try:
            async for item in source:
                await queue.put(item)
        except AppError as exc:
            await queue.put(("error", exc.to_dict()))
        except Exception:  # never leak stack traces to the client
            log.exception("stream failed")
            await queue.put(("error", {"code": "internal_error", "message": "Something went wrong while generating. Please try again."}))
        finally:
            await queue.put(DONE)

    task = asyncio.create_task(pump())
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=PING_SECONDS)
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                continue
            if item is DONE:
                break
            yield format_event(*item)
    finally:
        task.cancel()


def sse_response(source: AsyncIterator[tuple[str, dict]]) -> StreamingResponse:
    return StreamingResponse(
        _with_keepalive(source),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
