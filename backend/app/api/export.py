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
from app.services import docx_source, latex_source, uploads
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


def render_resume(body: ExportRequest) -> tuple[bytes, str, str]:
    """Return (data, mode, note). mode: "original-file" (the user's own DOCX/LaTeX
    edited in place), "style-match" (our renderer with the detected style) or "template"."""
    r, lay, fmt = body.resume, body.layout, body.format
    show = lay.show_summary
    src, note = None, ""
    if lay.template == "original" and body.source_id:
        src = uploads.load(body.source_id)
        if src is None:
            note = "Your original file has expired (uploads are kept for 48 hours), so a close style match was used. Re-upload to edit the original again."

    if fmt in ("txt", "md"):
        data = (to_markdown(r, include_summary=show) if fmt == "md" else to_text(r, include_summary=show)).encode("utf-8")
        return data, "template", note

    if src is not None and src.file_type == "tex" and fmt in ("tex", "pdf"):
        tex_src, _ = latex_source.apply_to_tex(src.data.decode("utf-8", "replace"), r, show)
        if fmt == "tex":
            return tex_src.encode("utf-8"), "original-file", note
        if pdf := latex_source.compile_tex(tex_src):
            return pdf, "original-file", note
        note = note or ("A LaTeX engine isn't available on this server (or the file uses features that can't be compiled safely), "
                        "so the preview is a close style match. Your .tex download keeps your exact template.")
    if src is not None and src.file_type == "docx" and fmt == "docx":
        data, _ = docx_source.apply_to_docx(src.data, r, show)
        return data, "original-file", note
    if src is not None and src.file_type == "docx" and fmt == "pdf" and not note:
        note = "PDF preview is a close style match. Your Word download edits your original file, so it keeps its exact design."

    mode = "style-match" if lay.template == "original" else "template"
    if fmt == "pdf":
        return ex.resume_pdf(r, lay), mode, note
    if fmt == "docx":
        return ex.resume_docx(r, lay), mode, note
    return resume_tex(r, lay).encode("utf-8"), mode, note


@router.post("/export/check", summary="Render the resume PDF and read it back like an ATS would")
async def export_check(body: ExportRequest):
    """Round trip: our own PDF → the same parser used for uploads. Proves the
    download is machine-readable: every section, bullet and contact detail recovered."""
    if body.resume is None:
        raise InvalidInputError("Nothing to check.", code="export_empty")
    r = body.resume
    data, _, _ = await run_in_threadpool(render_resume, body.model_copy(update={"format": "pdf"}))
    parsed = await run_in_threadpool(parse_resume, data, "check.pdf")
    norm = lambda t: re.sub(r"[^a-z0-9]+", "", t.lower())
    text = norm(parsed.text)
    bullets = [b.tailored or b.original for item in [*r.experience, *r.projects] for b in item.bullets if (b.tailored or b.original).strip()]
    found = sum(1 for b in bullets if norm(b)[:60] in text)
    show = body.layout.show_summary
    expected = [k for k, present in (("summary", show and bool(r.summary.tailored or r.summary.original)), ("skills", bool(r.skills.groups)),
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


@router.post("/export", summary="Download (or preview inline) a tailored resume or cover letter: PDF, DOCX, LaTeX, TXT or Markdown")
async def export(body: ExportRequest):
    if body.resume is None and not (body.cover_letter or "").strip():
        raise InvalidInputError("Nothing to export.", code="export_empty")
    mode, note = "template", ""
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
        name = _safe_name(body.filename, f"{_safe_name(body.resume.candidate.name, 'Tailored')}_Resume")
        data, mode, note = await run_in_threadpool(render_resume, body)

    full = f"{name}.{body.format}"
    ascii_name = unicodedata.normalize("NFKD", full).encode("ascii", "ignore").decode() or f"download.{body.format}"
    kind = "inline" if body.inline else "attachment"
    disposition = f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(full)}"
    return Response(content=data, media_type=MIME[body.format],
                    headers={"Content-Disposition": disposition, "X-Render-Mode": mode,
                             "X-Render-Note": quote(note), "Cache-Control": "no-store"})
