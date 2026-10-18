from __future__ import annotations

import re
import unicodedata
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from app.core.errors import InvalidInputError
from app.models.schemas import ExportRequest
from app.services import export as ex
from app.services.latex import resume_tex
from app.services.parsing import parse_resume
from app.services.render import to_markdown, to_text

router = APIRouter(prefix="/api", tags=["export"])

MIME = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "txt": "text/plain; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "tex": "application/x-tex; charset=utf-8",
}


def _safe_name(name: str, fallback: str) -> str:
    name = re.sub(r"[^\w\- ]+", "", name or "").strip().replace(" ", "_")
    return (name or fallback)[:80]


@router.post("/export/check", summary="Render the resume PDF and read it back like an ATS would")
async def export_check(body: ExportRequest):
    """Round trip: our own PDF → the same parser used for uploads. Proves the
    download is machine-readable: every section, bullet and contact detail recovered."""
    if body.resume is None:
        raise InvalidInputError("Nothing to check.", code="export_empty")
    r = body.resume
    data = await run_in_threadpool(ex.resume_pdf, r)
    parsed = await run_in_threadpool(parse_resume, data, "check.pdf")
    norm = lambda t: re.sub(r"[^a-z0-9]+", "", t.lower())
    text = norm(parsed.text)
    bullets = [b.tailored or b.original for item in [*r.experience, *r.projects] for b in item.bullets if (b.tailored or b.original).strip()]
    found = sum(1 for b in bullets if norm(b)[:60] in text)
    expected = [k for k, present in (("summary", bool(r.summary.tailored or r.summary.original)), ("skills", bool(r.skills.groups)),
                                       ("experience", bool(r.experience)), ("projects", bool(r.projects)), ("education", bool(r.education))) if present]
    email = r.candidate.contact.email
    return {
        "pages": ex.pdf_page_count(data),
        "sections_expected": expected,
        "sections_found": [s for s in expected if s in parsed.sections],
        "bullets_total": len(bullets),
        "bullets_found": found,
        "contact_found": (not email) or norm(email) in text,
        "layout": [c for c in parsed.layout if c["id"] in {"text_layer", "glyphs", "columns", "images"}],
    }


@router.post("/export", summary="Download a tailored resume or cover letter as PDF, DOCX, TXT or Markdown")
async def export(body: ExportRequest):
    if body.resume is None and not (body.cover_letter or "").strip():
        raise InvalidInputError("Nothing to export.", code="export_empty")

    if body.cover_letter is not None and body.resume is None:
        text = body.cover_letter.strip()
        name = _safe_name(body.filename, f"{_safe_name(body.candidate_name, 'Cover')}_Cover_Letter")
        if body.format == "pdf":
            data = await run_in_threadpool(ex.letter_pdf, text, body.candidate_name)
        elif body.format == "docx":
            data = await run_in_threadpool(ex.letter_docx, text, body.candidate_name)
        elif body.format == "tex":
            raise InvalidInputError("LaTeX export is available for resumes only.", code="export_unsupported")
        else:
            data = text.encode("utf-8")
    else:
        r = body.resume
        name = _safe_name(body.filename, f"{_safe_name(r.candidate.name, 'Tailored')}_Resume")
        if body.format == "pdf":
            data = await run_in_threadpool(ex.resume_pdf, r)
        elif body.format == "docx":
            data = await run_in_threadpool(ex.resume_docx, r)
        elif body.format == "md":
            data = to_markdown(r).encode("utf-8")
        elif body.format == "tex":
            data = resume_tex(r).encode("utf-8")
        else:
            data = to_text(r).encode("utf-8")

    full = f"{name}.{body.format}"
    ascii_name = unicodedata.normalize("NFKD", full).encode("ascii", "ignore").decode() or f"download.{body.format}"
    disposition = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(full)}"
    return Response(content=data, media_type=MIME[body.format],
                    headers={"Content-Disposition": disposition,
                             "Access-Control-Expose-Headers": "Content-Disposition"})
