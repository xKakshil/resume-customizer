"""File-level ATS parse check: *how* the uploaded file is built, not just what it says.

Most ATS failures come from layout, not wording: two-column designs that get
read across both columns line by line, contact details inside a Word header
that parsers skip, skills in tables or text boxes, icon fonts that come out as
garbage. These checks inspect the PDF geometry (via pdfplumber) or the DOCX
XML and report each problem with a concrete fix. No LLM involved.
"""

from __future__ import annotations

import io
import re
import statistics
import zipfile

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"\+?\d[\d\s().-]{8,}\d")
_LONE_GLYPH = re.compile(r"(\(cid:\d+\))+|[-]")


def _check(cid: str, label: str, status: str, detail: str, tip: str | None = None) -> dict:
    return {"id": cid, "label": label, "status": status, "detail": detail, "tip": tip if status != "pass" else None}


# --------------------------------------------------------------------------- #
# PDF
# --------------------------------------------------------------------------- #
def _line_groups(words: list[dict], tol: float = 3.0) -> list[list[dict]]:
    lines: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        if lines and abs(lines[-1][0]["top"] - w["top"]) <= tol:
            lines[-1].append(w)
        else:
            lines.append([w])
    return [sorted(l, key=lambda w: w["x0"]) for l in lines]


def _columns_score(words: list[dict], width: float) -> float:
    """Share of text lines split by a wide gap in the middle band of the page.

    Right-aligned dates ("Jan 2024 – Present") also create gaps, so a split only
    counts when the right-hand part starts well before the right margin and the
    left part ends after the first fifth of the page."""
    lines = [l for l in _line_groups(words) if len(l) >= 2]
    if len(lines) < 8:
        return 0.0
    split = 0
    for l in lines:
        for a, b in zip(l, l[1:]):
            gap = b["x0"] - a["x1"]
            if gap > 0.06 * width and 0.2 * width < a["x1"] and b["x0"] < 0.68 * width:
                split += 1
                break
    return split / len(lines)


def pdf_layout_checks(data: bytes) -> list[dict]:
    import pdfplumber

    checks: list[dict] = []
    try:
        pdf = pdfplumber.open(io.BytesIO(data))
    except Exception:
        return checks
    with pdf:
        pages = pdf.pages[:5]
        col_scores, tables, images, margin_contact, garbled, total_chars, fonts = [], 0, 0, False, 0, 0, set()
        for page in pages:
            try:
                words = page.extract_words(keep_blank_chars=False, use_text_flow=False, extra_attrs=["fontname"])
            except Exception:
                continue
            col_scores.append(_columns_score(words, float(page.width)))
            try:
                tables += sum(1 for t in page.find_tables() if len(t.rows) >= 2 and len(t.rows[0].cells) >= 2)
            except Exception:
                pass
            images += len(page.images or [])
            h = float(page.height)
            margin_text = " ".join(w["text"] for w in words if w["top"] < 0.05 * h or w["bottom"] > 0.95 * h)
            if _EMAIL.search(margin_text) or _PHONE.search(margin_text):
                margin_contact = True
            # A lone unmapped glyph is almost always a bullet symbol (harmless); count garbling *inside* words.
            txt = "".join(w["text"] for w in words if not _LONE_GLYPH.fullmatch(w["text"]))
            total_chars += len(txt)
            garbled += txt.count("(cid:") * 6 + txt.count("�") + sum(1 for ch in txt if 0xE000 <= ord(ch) <= 0xF8FF)
            fonts.update(w.get("fontname", "").split("+")[-1] for w in words)

    if not total_chars:
        return [_check("text_layer", "Selectable text", "fail", "No text layer — this looks like a scanned image.",
                       "Export the resume from Word/Google Docs as PDF instead of scanning or printing to image.")]
    checks.append(_check("text_layer", "Selectable text", "pass", "The PDF has a real text layer."))

    ratio = garbled / max(1, total_chars)
    checks.append(_check("glyphs", "Readable characters", "pass" if ratio < 0.002 else "warn" if ratio < 0.02 else "fail",
                         "Characters extract cleanly." if ratio < 0.002 else f"About {ratio:.1%} of characters come out garbled (icon fonts or unmapped glyphs).",
                         "Replace icon fonts (phone/email/LinkedIn symbols) with plain text labels, and use a standard font."))

    col = statistics.mean(col_scores) if col_scores else 0
    checks.append(_check("columns", "Single-column layout", "pass" if col < 0.25 else "warn" if col < 0.45 else "fail",
                         "Text flows in a single column." if col < 0.25 else f"{col:.0%} of lines are split into side-by-side columns.",
                         "Many ATS read across the page line by line, mixing two columns together. A single-column layout is safest."))

    checks.append(_check("tables", "No tables", "pass" if tables == 0 else "warn",
                         "No tables detected." if tables == 0 else f"{tables} table{'s' if tables > 1 else ''} detected.",
                         "Some ATS skip or scramble table cells. Put skills and dates in normal text lines."))
    checks.append(_check("images", "No images or graphics", "pass" if images == 0 else "warn",
                         "No images found." if images == 0 else f"{images} image{'s' if images > 1 else ''} found (photos, logos, skill bars or icons).",
                         "ATS can't read images. Remove photos, logos and skill-level bars; state information as text."))
    checks.append(_check("margins", "Contact details in the page body", "warn" if margin_contact else "pass",
                         "Contact details are in the main body." if not margin_contact else "Email or phone sits in the page header/footer area.",
                         "Some ATS ignore headers and footers. Move your email and phone into the top of the page body."))
    return checks


# --------------------------------------------------------------------------- #
# DOCX
# --------------------------------------------------------------------------- #
def docx_layout_checks(data: bytes) -> list[dict]:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            doc = zf.read("word/document.xml").decode("utf-8", "replace")
            headers = " ".join(zf.read(n).decode("utf-8", "replace") for n in zf.namelist()
                               if re.match(r"word/(header|footer)\d*\.xml$", n))
            media = [n for n in zf.namelist() if n.startswith("word/media/")]
    except Exception:
        return []
    header_text = re.sub(r"<[^>]+>", " ", headers)
    cols = re.search(r'<w:cols\b[^>]*w:num="([2-9])"', doc)
    tables = doc.count("<w:tbl>") + doc.count("<w:tbl ")
    textboxes = doc.count("<w:txbxContent")
    return [
        _check("columns", "Single-column layout", "fail" if cols else "pass",
               "Text flows in a single column." if not cols else f"The document uses {cols.group(1)} text columns.",
               "Many ATS read across the page line by line, mixing columns together. Use a single column."),
        _check("tables", "No tables", "pass" if not tables else "warn",
               "No tables detected." if not tables else f"{tables} table{'s' if tables > 1 else ''} detected.",
               "Some ATS skip or scramble table cells. Put skills and dates in normal text lines."),
        _check("textboxes", "No text boxes", "pass" if not textboxes else "fail",
               "No text boxes." if not textboxes else f"{textboxes} text box{'es' if textboxes > 1 else ''} found.",
               "Text inside text boxes is often skipped entirely by ATS parsers. Move it into the normal document flow."),
        _check("images", "No images or graphics", "pass" if not media else "warn",
               "No images found." if not media else f"{len(media)} image{'s' if len(media) > 1 else ''} embedded.",
               "ATS can't read images. Remove photos, logos and skill-level bars; state information as text."),
        _check("margins", "Contact details in the page body", "warn" if (_EMAIL.search(header_text) or _PHONE.search(header_text)) else "pass",
               "Contact details are in the main body." if not (_EMAIL.search(header_text) or _PHONE.search(header_text))
               else "Email or phone is inside the Word header/footer.",
               "Some ATS ignore headers and footers. Move your email and phone into the top of the document body."),
    ]


def layout_checks(data: bytes, file_type: str) -> list[dict]:
    try:
        return pdf_layout_checks(data) if file_type == "pdf" else docx_layout_checks(data)
    except Exception:  # a layout check must never break parsing
        return []
