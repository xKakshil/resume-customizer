"""Detect the visual style of an uploaded resume so exports can match it.

Output keys mirror `LayoutSettings` (page size, margins in inches, font family,
sizes, heading case/rule, header alignment, accent colour, line spacing), so the
frontend can use the result directly as the "Match original" template.

PDF: measured from character geometry and fonts (pdfplumber).
DOCX: read from section settings, styles and the runs themselves.
LaTeX: read from the preamble (see latex_source.tex_style).
"""

from __future__ import annotations

import io
import re
import statistics
from collections import Counter

from app.services.parsing import _HEADING_RE

_SERIF = re.compile(r"times|garamond|georgia|cambria|serif|cmr\d|lmroman|sfrm|palatino|charter|baskerville|"
                    r"bookantiqua|book antiqua|merriweather|caslon|didot|bodoni|minion|crimson|libertin|tex gyre|"
                    r"cmcsc|cmbx|cmti|nimbusrom|utopia|bitstream charter|constantia|century|pt serif|lora", re.I)
_BOLD = re.compile(r"bold|black|heavy|semibold|demi|cmbx|-b\b|,b\b", re.I)
_SMALLCAPS = re.compile(r"cmcsc|caps|-sc\b|smallcap", re.I)


def _clamp(v: float, lo: float, hi: float) -> float:
    return round(min(hi, max(lo, v)), 2)


def _hex(color) -> str | None:
    """pdfplumber colours are tuples in gray/RGB/CMYK space."""
    if color is None:
        return None
    try:
        c = [float(x) for x in (color if isinstance(color, (list, tuple)) else [color])]
    except (TypeError, ValueError):
        return None
    if len(c) == 1:
        r = g = b = c[0]
    elif len(c) == 3:
        r, g, b = c
    elif len(c) == 4:
        k = c[3]
        r, g, b = ((1 - c[0]) * (1 - k), (1 - c[1]) * (1 - k), (1 - c[2]) * (1 - k))
    else:
        return None
    return "#{:02x}{:02x}{:02x}".format(*(int(round(max(0, min(1, x)) * 255)) for x in (r, g, b)))


def _is_dark(hexcolor: str) -> bool:
    r, g, b = (int(hexcolor[i:i + 2], 16) for i in (1, 3, 5))
    return max(r, g, b) < 60


def pdf_style(data: bytes) -> dict:
    import pdfplumber

    try:
        pdf = pdfplumber.open(io.BytesIO(data))
    except Exception:
        return {}
    with pdf:
        if not pdf.pages:
            return {}
        p0 = pdf.pages[0]
        w, h = float(p0.width), float(p0.height)
        pages = pdf.pages[:3]
        chars = [c for p in pages for c in p.chars if c.get("text", "").strip()]
        if not chars:
            return {}
        first = [c for c in p0.chars if c.get("text", "").strip()]
        lines_by_page = [(p, p.extract_text_lines(return_chars=True)) for p in pages]
        hrules = [ln for p in pages for ln in (p.lines or []) + (p.rects or [])
                  if abs(float(ln["bottom"]) - float(ln["top"])) < 2.5 and float(ln["x1"]) - float(ln["x0"]) > 0.45 * w]

    sizes = Counter(round(float(c["size"]) * 2) / 2 for c in chars)
    body = sizes.most_common(1)[0][0]
    fonts = Counter(c.get("fontname", "").split("+")[-1] for c in chars)
    body_font = fonts.most_common(1)[0][0]

    left = min(float(c["x0"]) for c in chars)
    right = w - max(float(c["x1"]) for c in chars)
    top = min(float(c["top"]) for c in first)
    bottoms = [max(float(c["bottom"]) for c in p.chars if c.get("text", "").strip()) for p in pages if any(c.get("text", "").strip() for c in p.chars)]
    bottom = h - (max(bottoms) if len(bottoms) == 1 else bottoms[0])
    if len(bottoms) == 1 and bottom > max(top, 0.4 * 72) * 1.6:
        bottom = top  # a one-page resume that doesn't fill the page: mirror the top margin

    # Name = largest text near the top of page 1.
    top_lines = [ln for ln in lines_by_page[0][1] if float(ln["top"]) < h * 0.2] if lines_by_page else []
    name_line = max(top_lines, key=lambda ln: max(float(c["size"]) for c in ln["chars"]), default=None)
    name_size = max((float(c["size"]) for c in name_line["chars"]), default=body * 1.8) if name_line else body * 1.8
    header_align = "left"
    if name_line:
        mid = (float(name_line["x0"]) + float(name_line["x1"])) / 2
        header_align = "center" if abs(mid - w / 2) < 0.08 * w else "left"

    # Section headings.
    heads = []
    for _, lines in lines_by_page:
        for ln in lines:
            txt = ln["text"].strip().strip(":")
            if 2 < len(txt) < 45 and any(rx.match(txt) for rx in _HEADING_RE.values()):
                heads.append(ln)
    heading_size, heading_case, heading_rule, accent = body + 1, "title", False, None
    if heads:
        heading_size = statistics.median(max(float(c["size"]) for c in ln["chars"]) for ln in heads)
        texts = [ln["text"].strip() for ln in heads]
        hfonts = " ".join(ln["chars"][0].get("fontname", "") for ln in heads)
        if _SMALLCAPS.search(hfonts):
            heading_case = "smallcaps"
        elif sum(t.isupper() for t in texts) >= len(texts) / 2:
            heading_case = "upper"
        colors = Counter(_hex(ln["chars"][0].get("non_stroking_color")) for ln in heads)
        accent = colors.most_common(1)[0][0]
        heading_rule = any(any(0 <= float(r["top"]) - float(ln["bottom"]) < 14 for ln in heads) for r in hrules) or len(hrules) >= len(heads) / 2
    if not accent or _is_dark(accent):
        name_color = _hex(name_line["chars"][0].get("non_stroking_color")) if name_line else None
        accent = name_color if name_color and not _is_dark(name_color) else "#111111"

    gaps = []
    for _, lines in lines_by_page:
        tops = sorted(float(ln["top"]) for ln in lines)
        gaps += [b - a for a, b in zip(tops, tops[1:]) if 0 < b - a < body * 2.2]
    # Lower quantile = line-to-line distance inside paragraphs (ignores section gaps).
    spacing = (statistics.quantiles(gaps, n=10)[2] if len(gaps) >= 10 else statistics.median(gaps)) / body if gaps else 1.25

    return {
        "detected": True, "source": "pdf",
        "page_size": "Letter" if abs(h - 792) < 15 and abs(w - 612) < 15 else "A4",
        "margins": {"top": _clamp(top / 72, 0.25, 1.6), "bottom": _clamp(bottom / 72, 0.25, 1.6),
                    "left": _clamp(left / 72, 0.25, 1.6), "right": _clamp(right / 72, 0.25, 1.6)},
        "font_family": "serif" if _SERIF.search(body_font) else "sans",
        "font_name": body_font,
        "font_size": _clamp(body, 8, 13), "name_size": _clamp(name_size, 12, 32), "heading_size": _clamp(heading_size, 8, 18),
        "heading_case": heading_case, "heading_rule": bool(heading_rule), "header_align": header_align,
        "accent": accent, "line_spacing": _clamp(spacing, 1.0, 1.8),
    }


def docx_style(data: bytes) -> dict:
    import docx
    from docx.shared import Emu

    try:
        d = docx.Document(io.BytesIO(data))
    except Exception:
        return {}
    sec = d.sections[0]
    inch = lambda v: _clamp(Emu(v).inches if v is not None else 1.0, 0.25, 2.0)
    width = Emu(sec.page_width).inches if sec.page_width else 8.27
    normal = d.styles["Normal"].font
    sizes, fonts = Counter(), Counter()
    paras = [p for p in d.paragraphs if p.text.strip()]
    for p in paras:
        for r in p.runs:
            if r.text.strip():
                sz = r.font.size.pt if r.font.size else (normal.size.pt if normal.size else None)
                if sz:
                    sizes[round(sz * 2) / 2] += len(r.text)
                fonts[r.font.name or normal.name or ""] += len(r.text)
    body = sizes.most_common(1)[0][0] if sizes else (normal.size.pt if normal.size else 10.5)
    font = (fonts.most_common(1)[0][0] if fonts else "") or normal.name or "Calibri"

    name_size, header_align = body * 1.8, "left"
    if paras:
        p0 = paras[0]
        szs = [r.font.size.pt for r in p0.runs if r.font.size]
        name_size = max(szs) if szs else name_size
        header_align = "center" if p0.alignment is not None and int(p0.alignment) == 1 else "left"

    heads = [p for p in paras if len(p.text.strip()) < 45 and any(rx.match(p.text.strip().strip(":")) for rx in _HEADING_RE.values())]
    heading_size, heading_case, heading_rule, accent = body + 1, "title", False, "#111111"
    if heads:
        hs = [r.font.size.pt for p in heads for r in p.runs if r.font.size]
        heading_size = statistics.median(hs) if hs else body + 1
        if sum(p.text.strip().isupper() or any(r.font.all_caps for r in p.runs) for p in heads) >= len(heads) / 2:
            heading_case = "upper"
        if any(r.font.small_caps for p in heads for r in p.runs):
            heading_case = "smallcaps"
        heading_rule = any("w:pBdr" in p._p.xml and "w:bottom" in p._p.xml for p in heads)
        col = next((r.font.color.rgb for p in heads for r in p.runs if r.font.color is not None and r.font.color.type is not None and r.font.color.rgb), None)
        if col is not None:
            accent = f"#{col}".lower()
    return {
        "detected": True, "source": "docx",
        "page_size": "Letter" if abs(width - 8.5) < 0.15 else "A4",
        "margins": {"top": inch(sec.top_margin), "bottom": inch(sec.bottom_margin), "left": inch(sec.left_margin), "right": inch(sec.right_margin)},
        "font_family": "serif" if _SERIF.search(font) else "sans", "font_name": font,
        "font_size": _clamp(body, 8, 13), "name_size": _clamp(name_size, 12, 32), "heading_size": _clamp(heading_size, 8, 18),
        "heading_case": heading_case, "heading_rule": heading_rule, "header_align": header_align,
        "accent": accent if re.fullmatch(r"#[0-9a-f]{6}", accent) else "#111111", "line_spacing": 1.2,
    }


def detect_style(data: bytes, file_type: str) -> dict:
    try:
        if file_type == "pdf":
            return pdf_style(data)
        if file_type == "docx":
            return docx_style(data)
        if file_type == "tex":
            from app.services.latex_source import tex_style
            return tex_style(data.decode("utf-8", "replace"))
    except Exception:
        return {}
    return {}
