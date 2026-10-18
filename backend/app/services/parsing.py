"""Resume file parsing: validate the upload, extract clean text from PDF/DOCX,
and surface useful metadata (links, detected sections, warnings).

Design notes
- File type is decided by *magic bytes*, never by the extension or the
  browser-supplied content type, both of which are trivially wrong or spoofed.
- Text is normalised (ligatures, odd bullet glyphs, hyphenation, `(cid:NN)`
  artefacts) so the LLM and the keyword scorer see the same clean input.
- Hyperlinks hidden behind text ("LinkedIn", "GitHub") are recovered from PDF
  annotations / DOCX relationships, because recruiters care about them.
"""

from __future__ import annotations

import io
import re
import unicodedata
import zipfile
from dataclasses import dataclass, field

from app.config import get_settings
from app.core.errors import FileTooLargeError, ParseError, UnsupportedFileError
from app.services.layout_check import layout_checks

PDF_MAGIC = b"%PDF-"
ZIP_MAGIC = b"PK\x03\x04"
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # legacy .doc / encrypted .docx

SECTION_PATTERNS: dict[str, str] = {
    "summary": r"(professional\s+)?summary|profile|objective|about\s+me|career\s+objective",
    "experience": r"(work|professional|employment)?\s*(experience|history)|internships?",
    "education": r"education|academics?|academic\s+(background|details|qualifications?)",
    "skills": r"(technical\s+|core\s+|key\s+)?skills|technologies|tech\s+stack|competencies|tools",
    "projects": r"(academic\s+|personal\s+|key\s+)?projects",
    "certifications": r"certifications?|licen[cs]es|courses|coursework",
    "achievements": r"achievements|awards|honou?rs|accomplishments",
    "positions": r"positions?\s+of\s+responsibility|leadership|extra[-\s]?curricular|activities|volunteer(ing)?",
    "publications": r"publications|research",
}
_HEADING_RE = {k: re.compile(rf"^\s*({v})\s*:?\s*$", re.I) for k, v in SECTION_PATTERNS.items()}

_LIGATURES = {"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st"}
_BULLETS = "•●▪■◦‣⁃∙➢➤►▸✓✔❖♦◆★☆·"
_BULLET_RE = re.compile(rf"^[ \t]*[{_BULLETS}][ \t]*", re.M)
_DASH_BULLET_RE = re.compile(r"^[ \t]*[-–—*][ \t]+", re.M)
_CID_RE = re.compile(r"\(cid:\d+\)")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE_RE = re.compile(r"(\+?\d[\d\s().-]{8,}\d)")
_URL_RE = re.compile(r"(https?://[^\s)>\]]+|(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com|leetcode\.com|codeforces\.com|kaggle\.com|behance\.net|dribbble\.com)/[^\s)>\]]+)", re.I)


@dataclass
class ParsedResume:
    text: str
    filename: str
    file_type: str
    size_bytes: int
    pages: int | None
    links: list[str] = field(default_factory=list)
    sections: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    layout: list[dict] = field(default_factory=list)
    style: dict = field(default_factory=dict)
    source_id: str = ""

    @property
    def word_count(self) -> int:
        return len(self.text.split())

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "filename": self.filename,
            "file_type": self.file_type,
            "size_bytes": self.size_bytes,
            "pages": self.pages,
            "word_count": self.word_count,
            "char_count": len(self.text),
            "links": self.links,
            "sections": self.sections,
            "warnings": self.warnings,
            "layout": self.layout,
            "style": self.style,
            "source_id": self.source_id,
        }


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def detect_file_type(data: bytes, filename: str) -> str:
    """Return 'pdf' or 'docx' based on content, raising a helpful error otherwise."""
    head = data[:8]
    name = (filename or "").lower()
    if head.startswith(PDF_MAGIC) or (b"%PDF-" in data[:1024]):
        return "pdf"
    if head.startswith(ZIP_MAGIC):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                names = set(zf.namelist())
        except zipfile.BadZipFile as exc:
            raise ParseError("This DOCX file appears to be corrupted and could not be opened.") from exc
        if "word/document.xml" in names:
            return "docx"
        raise UnsupportedFileError("This ZIP-based file is not a Word document. Please upload a PDF or DOCX resume.")
    if head.startswith(OLE_MAGIC):
        if name.endswith(".docx"):
            raise UnsupportedFileError("This DOCX is password-protected. Please remove the password and upload it again.")
        raise UnsupportedFileError("Legacy .doc files aren't supported. Open it in Word or Google Docs and save as PDF or DOCX.")
    if name.endswith((".png", ".jpg", ".jpeg", ".webp", ".heic")):
        raise UnsupportedFileError("Images aren't supported. Please upload your resume as a PDF, DOCX or LaTeX (.tex) file.")
    head_text = data[:4096].decode("utf-8", "ignore")
    if b"\x00" not in data[:4096]:
        if name.endswith(".tex") or re.search(r"\\documentclass|\\begin\{document\}", head_text):
            return "tex"
        if name.endswith((".txt", ".md", ".markdown", ".text")):
            return "txt"
    raise UnsupportedFileError("Unsupported file type. Please upload a PDF, DOCX or LaTeX (.tex) resume.")


def parse_resume(data: bytes, filename: str, purpose: str = "resume") -> ParsedResume:
    """purpose="resume" for the primary resume (strict checks), "supporting" for
    optional extra documents (plain text allowed, no resume-shape warnings)."""
    settings = get_settings()
    if not data:
        raise ParseError("The uploaded file is empty.", code="empty_file")
    if len(data) > settings.max_upload_bytes:
        raise FileTooLargeError(
            f"File is {len(data) / 1024 / 1024:.1f} MB. The maximum allowed size is {settings.max_upload_mb:g} MB.",
            details={"max_mb": settings.max_upload_mb},
        )

    file_type = detect_file_type(data, filename)
    if file_type == "txt" and purpose == "resume":
        raise UnsupportedFileError("Plain-text files can be added as supporting documents. For your resume, upload a PDF, DOCX or LaTeX (.tex) file.")
    pages = None
    if file_type == "pdf":
        raw, pages, links = _extract_pdf(data, settings.max_pdf_pages)
    elif file_type == "docx":
        raw, links = _extract_docx(data)
    elif file_type == "tex":
        from app.services.latex_source import tex_to_text
        try:
            raw, links = tex_to_text(data.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise ParseError("This .tex file isn't UTF-8 text. Save it as UTF-8 and try again.", code="bad_encoding") from exc
    else:
        raw, links = data.decode("utf-8", "replace"), []

    text = normalize_text(raw)
    links = _dedupe(links + _URL_RE.findall(text))
    warnings: list[str] = []

    if len(text.strip()) < 40:
        if file_type == "pdf":
            raise ParseError(
                "We couldn't find any selectable text in this PDF. It looks like a scanned image. "
                "Please upload a text-based PDF or a DOCX (export from Word/Google Docs instead of scanning).",
                code="no_text",
            )
        raise ParseError("This document doesn't contain any readable text.", code="no_text")

    if purpose == "supporting":
        if len(text) < 30:
            raise ParseError("This document has too little text to be useful.", code="too_short")
        return ParsedResume(text=text[:20_000], filename=filename or f"document.{file_type}", file_type=file_type,
                            size_bytes=len(data), pages=pages, links=links, sections=detect_sections(text),
                            warnings=["Only the first 20,000 characters were kept."] if len(text) > 20_000 else [])

    if len(text) < settings.min_resume_chars:
        raise ParseError(
            f"Only {len(text)} characters of text were found. That's too little to tailor; "
            "please check you uploaded the full resume.",
            code="too_short",
        )
    if len(text) > settings.max_resume_chars:
        text = text[: settings.max_resume_chars]
        warnings.append("Your resume is unusually long, so only the first part was used. Consider trimming to 1–2 pages.")

    sections = detect_sections(text)
    if not _EMAIL_RE.search(text):
        warnings.append("No email address was found. Recruiters and ATS systems expect one at the top.")
    if not ({"experience", "education", "projects"} & set(sections)):
        warnings.append(
            "We couldn't spot standard sections like Experience or Education. "
            "Is this a resume? Clear section headings also help ATS parsers."
        )
    if pages and pages > 3:
        warnings.append(f"Your resume is {pages} pages long. Most recruiters prefer 1–2 pages.")

    layout = layout_checks(data, file_type) if file_type in ("pdf", "docx") else []
    for c in layout:
        if c["status"] == "fail" and c["id"] in {"columns", "textboxes", "glyphs"}:
            warnings.append(f"{c['detail']} {c['tip']}")

    return ParsedResume(
        text=text, filename=filename or f"resume.{file_type}", file_type=file_type,
        size_bytes=len(data), pages=pages, links=links, sections=sections, warnings=warnings, layout=layout,
    )


def normalize_text(text: str) -> str:
    for lig, rep in _LIGATURES.items():
        text = text.replace(lig, rep)
    text = unicodedata.normalize("NFKC", text)
    # Unmapped glyphs at the start of a line are almost always bullet symbols.
    text = re.sub(r"^[ \t]*(\(cid:\d+\)[ \t]*)+", "• ", text, flags=re.M)
    text = _CID_RE.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")
    text = text.replace(" ", " ").replace("​", "").replace("﻿", "")
    text = _BULLET_RE.sub("• ", text)  # before stripping private-use glyphs (Word's \uf0b7 bullets)
    text = "".join(ch for ch in text if ch == "\n" or unicodedata.category(ch)[0] != "C")
    text = _DASH_BULLET_RE.sub("• ", text)
    # Re-join words broken across lines with a hyphen ("develop-\nment").
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = re.sub(r"[ ]{2,}", " ", text)
    text = re.sub(r" +\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = _join_wrapped_bullets(text)
    return text.strip()


def _join_wrapped_bullets(text: str) -> str:
    """PDF extraction breaks long bullets across lines; re-join continuations
    (lines starting lowercase / with a digit right after a bullet line)."""
    out: list[str] = []
    for line in text.split("\n"):
        stripped = line.strip()
        if (out and out[-1].startswith("• ") and stripped and not stripped.startswith("•")
                and (stripped[0].islower() or stripped[0].isdigit() or stripped[0] in "(&%")
                and not out[-1].rstrip().endswith((".", ":", ";"))):
            out[-1] = out[-1].rstrip() + " " + stripped
        else:
            out.append(line)
    return "\n".join(out)


def detect_sections(text: str) -> list[str]:
    found: list[str] = []
    for line in text.splitlines():
        candidate = line.strip().strip("•:|-").strip()
        if not candidate or len(candidate) > 45:
            continue
        for key, rx in _HEADING_RE.items():
            if key not in found and rx.match(candidate):
                found.append(key)
                break
    return found


# --------------------------------------------------------------------------- #
# Extractors
# --------------------------------------------------------------------------- #
def _extract_pdf(data: bytes, max_pages: int) -> tuple[str, int, list[str]]:
    import pdfplumber
    from pdfminer.pdfdocument import PDFPasswordIncorrect

    try:
        pdf = pdfplumber.open(io.BytesIO(data))
    except PDFPasswordIncorrect as exc:
        raise ParseError("This PDF is password-protected. Please remove the password and try again.", code="encrypted") from exc
    except Exception as exc:  # pdfminer raises a zoo of exception types for damaged files
        if _is_password_error(exc):
            raise ParseError("This PDF is password-protected. Please remove the password and try again.", code="encrypted") from exc
        raise ParseError("This PDF appears to be corrupted and could not be read.", code="corrupted") from exc

    with pdf:
        try:
            n_pages = len(pdf.pages)
        except Exception as exc:
            if _is_password_error(exc):
                raise ParseError("This PDF is password-protected. Please remove the password and try again.", code="encrypted") from exc
            raise ParseError("This PDF appears to be corrupted and could not be read.", code="corrupted") from exc
        if n_pages == 0:
            raise ParseError("This PDF has no pages.", code="corrupted")
        if n_pages > max_pages:
            raise ParseError(
                f"This PDF has {n_pages} pages. Resumes longer than {max_pages} pages aren't supported.",
                code="too_many_pages",
            )
        chunks: list[str] = []
        links: list[str] = []
        for page in pdf.pages:
            try:
                chunks.append(page.extract_text(x_tolerance=1.5, y_tolerance=3) or "")
                for h in page.hyperlinks or []:
                    uri = (h.get("uri") or "").strip()
                    if uri and not uri.lower().startswith(("mailto:", "tel:")):
                        links.append(uri)
            except Exception:  # one bad page shouldn't sink the whole resume
                continue
    return "\n\n".join(chunks), n_pages, links


def _is_password_error(exc: BaseException) -> bool:
    text = f"{type(exc).__name__} {exc!r} {exc.__cause__!r}".lower()
    return "password" in text or "encrypt" in text


def _extract_docx(data: bytes) -> tuple[str, list[str]]:
    import docx
    from docx.oxml.ns import qn

    try:
        document = docx.Document(io.BytesIO(data))
    except Exception as exc:
        raise ParseError("This DOCX file appears to be corrupted and could not be read.", code="corrupted") from exc

    lines: list[str] = []

    def para_text(p) -> str:
        txt = p.text.strip()
        if not txt:
            return ""
        style = (p.style.name if p.style is not None else "") or ""
        is_list = "List" in style or p._p.find(qn("w:pPr")) is not None and p._p.pPr.numPr is not None
        return f"• {txt}" if is_list and not txt.startswith("•") else txt

    def walk(container) -> None:
        # Iterate body children in document order so tables stay in place.
        for child in container.element.body.iterchildren() if hasattr(container, "element") and hasattr(container.element, "body") else []:
            if child.tag == qn("w:p"):
                lines.append(para_text(docx.text.paragraph.Paragraph(child, container)))
            elif child.tag == qn("w:tbl"):
                table = docx.table.Table(child, container)
                seen: set[int] = set()
                for row in table.rows:
                    cells = []
                    for cell in row.cells:
                        if id(cell._tc) in seen:  # merged cells repeat
                            continue
                        seen.add(id(cell._tc))
                        cell_lines = [para_text(p) for p in cell.paragraphs]
                        cells.append("\n".join(x for x in cell_lines if x))
                    lines.append("\n".join(c for c in cells if c))

    walk(document)

    header_lines: list[str] = []
    for section in document.sections:
        for part in (section.header, section.footer):
            try:
                header_lines.extend(p.text.strip() for p in part.paragraphs if p.text.strip())
            except Exception:
                pass

    links = [rel.target_ref for rel in document.part.rels.values() if "hyperlink" in rel.reltype and rel.is_external]
    text = "\n".join(_dedupe(header_lines)) + "\n" + "\n".join(lines)
    return text, links


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = item.strip().rstrip("/").lower()
        if key and key not in seen:
            seen.add(key)
            out.append(item.strip())
    return out
