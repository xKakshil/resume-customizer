from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from app.api.sse import sse_response
from app.config import get_settings
from app.core import rate_limit
from app.core.errors import FileTooLargeError
from app.core.security import optional_user
from app.models.db import Run, User, get_db, session
from app.models.schemas import ScoreRequest, TailorRequest
from app.services.parsing import parse_resume
from app.services.tailor import compute_scores, tailor, tailor_stream, validate_inputs

router = APIRouter(prefix="/api", tags=["resume"])
log = logging.getLogger(__name__)


async def _read_limited(file: UploadFile, limit: int) -> bytes:
    chunks, size = [], 0
    while chunk := await file.read(256 * 1024):
        size += len(chunk)
        if size > limit:
            raise FileTooLargeError(f"File is larger than the {limit / 1024 / 1024:g} MB limit.",
                                    details={"max_mb": limit / 1024 / 1024})
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/resume/parse", summary="Upload a PDF/DOCX resume and extract its text")
async def parse(request: Request, file: UploadFile = File(...)):
    rate_limit.check(request, "parse", 40)
    data = await _read_limited(file, get_settings().max_upload_bytes)
    parsed = await run_in_threadpool(parse_resume, data, file.filename or "")
    return parsed.to_dict()


@router.post("/score", summary="Keyword match + ATS score of a resume against a JD (no LLM)")
async def score(body: ScoreRequest):
    jd, resume = validate_inputs(body.job_description, body.resume_text)
    return compute_scores(jd, resume)


def _save_run(user_id: int, req: TailorRequest, result: dict) -> int:
    with session() as db:
        r = result["resume"]
        run = Run(
            user_id=user_id, kind="resume",
            title=r["jd_analysis"].get("role_title", "")[:200] or "Tailored resume",
            company=r["jd_analysis"].get("company", "")[:200],
            job_description=req.job_description, resume_filename=req.resume_filename[:255], resume_text=req.resume_text,
            result=result, match_before=result["scores"]["match"]["before"].get("score"),
            match_after=result["scores"]["match"].get("after", {}).get("score"),
        )
        db.add(run)
        db.commit()
        return run.id


@router.post("/tailor", summary="Tailor a resume to a JD (single JSON response)")
async def tailor_endpoint(req: TailorRequest, request: Request, user: User | None = Depends(optional_user)):
    rate_limit.rate_limit_llm(request)
    result = await tailor(req)
    if user:
        result["id"] = await run_in_threadpool(_save_run, user.id, req, result)
    return result


@router.post("/tailor/stream", summary="Tailor a resume to a JD, streaming progress and tokens over SSE")
async def tailor_stream_endpoint(req: TailorRequest, request: Request, user: User | None = Depends(optional_user)):
    rate_limit.rate_limit_llm(request)
    validate_inputs(req.job_description, req.resume_text)  # fail fast with a normal 422 before the stream opens
    user_id = user.id if user else None

    async def events():
        async for event, data in tailor_stream(req):
            if event == "result" and user_id:
                try:
                    data["id"] = await run_in_threadpool(_save_run, user_id, req, data)
                except Exception:
                    log.exception("failed to save history")
            yield event, data

    return sse_response(events())
