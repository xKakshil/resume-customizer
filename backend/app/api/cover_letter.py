from __future__ import annotations

from fastapi import APIRouter, Request

from app.api.sse import sse_response
from app.core import rate_limit
from app.models.schemas import CoverLetterRequest
from app.services.llm.factory import get_chain
from app.services.prompts import build_cover_letter_messages
from app.services.tailor import validate_inputs

router = APIRouter(prefix="/api/cover-letter", tags=["cover letter"])


def _messages(req: CoverLetterRequest) -> list[dict]:
    jd, resume = validate_inputs(req.job_description, req.resume_text)
    return build_cover_letter_messages(jd, resume, req.tone, req.length, req.hiring_manager, req.company)


def _clean(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`").split("\n", 1)[-1]
    return text.replace("**", "").strip()


@router.post("", summary="Generate a cover letter")
async def cover_letter(req: CoverLetterRequest, request: Request):
    rate_limit.rate_limit_llm(request)
    text, provider = await get_chain().complete(_messages(req), temperature=0.7)
    return {"text": _clean(text), "provider": provider.name, "model": provider.model}


@router.post("/stream", summary="Generate a cover letter, streaming tokens over SSE")
async def cover_letter_stream(req: CoverLetterRequest, request: Request):
    rate_limit.rate_limit_llm(request)
    messages = _messages(req)

    async def events():
        parts: list[str] = []
        provider = None
        async for kind, value in get_chain().stream(messages, temperature=0.7):
            if kind == "provider":
                provider = value
                yield "status", {"stage": "writing", "provider": value.name, "model": value.model}
            else:
                parts.append(value)
                yield "delta", {"text": value}
        yield "result", {"text": _clean("".join(parts)), "provider": provider.name, "model": provider.model}

    return sse_response(events())
