from __future__ import annotations

from fastapi import APIRouter, Request

from app.core import rate_limit
from app.models.schemas import ChatRequest
from app.services.chat import chat

router = APIRouter(prefix="/api", tags=["chat"])


@router.post("/chat", summary="Ask the AI to change or explain the tailored resume; returns a proposal to accept or discard")
async def chat_endpoint(req: ChatRequest, request: Request):
    rate_limit.rate_limit_llm(request)
    return await chat(req)
