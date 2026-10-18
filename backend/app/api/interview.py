from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import ValidationError

from app.core import rate_limit
from app.core.errors import LLMError
from app.models.schemas import InterviewPrep, InterviewPrepRequest
from app.services.llm.factory import get_chain
from app.services.prompts import build_interview_messages
from app.services.tailor import extract_json, validate_inputs

router = APIRouter(prefix="/api", tags=["interview prep"])


@router.post("/interview-prep", summary="Likely interview questions with resume-grounded answer points")
async def interview_prep(req: InterviewPrepRequest, request: Request):
    rate_limit.rate_limit_llm(request)
    jd, resume = validate_inputs(req.job_description, req.resume_text)
    messages = build_interview_messages(jd, resume, req.count)
    for temperature in (0.5, 0.2):
        text, provider = await get_chain().complete(messages, json_mode=True, temperature=temperature)
        try:
            prep = InterviewPrep.model_validate(extract_json(text))
        except (ValueError, ValidationError):
            continue
        prep.questions = [q for q in prep.questions if q.question.strip()][: req.count]
        if prep.questions:
            return {**prep.model_dump(), "provider": provider.name, "model": provider.model}
    raise LLMError("The AI returned an incomplete answer. Please try again.", code="llm_bad_output")
