"""Export a tailored resume / cover letter as an ATS-friendly PDF or DOCX.

Both formats use a single-column layout, real text (no images), standard
section headings and a common font — the things ATS parsers handle best.
"""

from __future__ import annotations

import io
import os
import re
from xml.sax.saxutils import escape

from app.models.schemas import TailoredResume
from app.services.render import _join

ACCENT = (0.13, 0.20, 0.35)
_FAMILIES: dict[str, tuple[str, str]] = {}
_FONT_CANDIDATES = {
    "sans": [("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
             ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
             ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf")],
    "serif": [("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"),
              ("/System/Library/Fonts/Supplemental/Times New Roman.ttf", "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf"),
              ("C:/Windows/Fonts/times.ttf", "C:/Windows/Fonts/timesbd.ttf")],
}
_BUILTIN = {"sans": ("Helvetica", "Helvetica-Bold"), "serif": ("Times-Roman", "Times-Bold")}


def _register_fonts(family: str = "sans") -> tuple[str, str]:
    """A TrueType family with wide Unicode coverage when available (DejaVu in Docker,
    Arial/Times on macOS & Windows), else the PDF built-ins."""
    family = family if family in _FONT_CANDIDATES else "sans"
    if family in _FAMILIES:
        return _FAMILIES[family]
    from reportlab.lib.fonts import addMapping
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    chosen = _BUILTIN[family]
    for regular, bold in _FONT_CANDIDATES[family]:
        if os.path.exists(regular) and os.path.exists(bold):
            try:
                name = f"Body{family.title()}"
                pdfmetrics.registerFont(TTFont(name, regular))
                pdfmetrics.registerFont(TTFont(name + "-Bold", bold))
                for b, i in ((0, 0), (0, 1)):
                    addMapping(name, b, i, name)
                for b, i in ((1, 0), (1, 1)):
                    addMapping(name, b, i, name + "-Bold")
                chosen = (name, name + "-Bold")
            except Exception:
                pass
            break
    _FAMILIES[family] = chosen
    return chosen


def _layout(layout):
    from app.models.schemas import LayoutSettings
    return layout if layout is not None else LayoutSettings()


def _heading_markup(title: str, case: str, size: float) -> str:
    title = escape(title)
    if case == "upper":
        return title.upper()
    if case == "smallcaps":  # emulate small caps: full-size initials, reduced capitals
        words = []
        for w in title.split():
            words.append(w[0].upper() + (f'<font size="{size * 0.8:.1f}">{w[1:].upper()}</font>' if len(w) > 1 else ""))
        return " ".join(words)
    return title


# --------------------------------------------------------------------------- #
# PDF
# --------------------------------------------------------------------------- #
def resume_pdf(r: TailoredResume, layout=None) -> bytes:
    """Render with the requested page setup; with `one_page`, if the resume just
    spills onto an extra page, retry slightly tighter and keep it if that saves a page."""
    lay = _layout(layout)
    data, pages = _resume_pdf(r, lay, squeeze=1.0)
    if lay.one_page and pages > 1:
        for squeeze in (0.95, 0.9):
            tight, tight_pages = _resume_pdf(r, lay, squeeze=squeeze)
            if tight_pages < pages:
                return tight
    return data


def pdf_page_count(data: bytes) -> int:
    return len(re.findall(rb"/Type\s*/Page[^s]", data))


def _resume_pdf(r: TailoredResume, lay, *, squeeze: float) -> tuple[bytes, int]:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT
    from reportlab.lib.pagesizes import A4, LETTER
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import HRFlowable, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    font, bold = _register_fonts(lay.font_family)
    accent = colors.HexColor(lay.accent)
    muted = colors.HexColor("#444444")
    fs = lay.font_size * squeeze
    lead = fs * lay.line_spacing
    align = TA_CENTER if lay.header_align == "center" else TA_LEFT
    page = LETTER if lay.page_size == "Letter" else A4
    m = lay.margins
    mk = 1.0 if squeeze == 1.0 else squeeze  # margins shrink a little too when squeezing
    left, right, top, bottom = (max(0.3, v * mk) * inch for v in (m.left, m.right, m.top, m.bottom))
    width = page[0] - left - right
    hs = lay.heading_size * squeeze
    st = {
        "name": ParagraphStyle("name", fontName=bold, fontSize=lay.name_size * squeeze, leading=lay.name_size * squeeze * 1.2, alignment=align, textColor=accent),
        "headline": ParagraphStyle("headline", fontName=font, fontSize=fs + 0.8, leading=(fs + 0.8) * 1.3, alignment=align, textColor=colors.HexColor("#333333")),
        "contact": ParagraphStyle("contact", fontName=font, fontSize=fs - 0.8, leading=(fs - 0.8) * 1.35, alignment=align, textColor=muted),
        "h": ParagraphStyle("h", fontName=bold, fontSize=hs, leading=hs * 1.2, textColor=accent, spaceBefore=fs * 0.85, spaceAfter=1),
        "body": ParagraphStyle("body", fontName=font, fontSize=fs, leading=lead),
        "role": ParagraphStyle("role", fontName=bold, fontSize=fs + 0.2, leading=lead),
        "meta": ParagraphStyle("meta", fontName=font, fontSize=fs - 0.6, leading=lead, alignment=2, textColor=muted),
        "sub": ParagraphStyle("sub", fontName=font, fontSize=fs - 0.4, leading=lead * 0.95, textColor=muted),
    }
    st["li"] = ParagraphStyle("li", parent=st["body"], leftIndent=fs * 1.25, bulletIndent=fs * 0.2, bulletFontName=font, bulletFontSize=fs * 0.9, spaceAfter=0.6)
    e = lambda s: escape(s or "")
    story: list = []

    if r.candidate.name:
        story.append(Paragraph(e(r.candidate.name), st["name"]))
    if r.candidate.headline:
        story.append(Paragraph(e(r.candidate.headline), st["headline"]))
    c = r.candidate.contact
    bits = [e(x) for x in (c.email, c.phone, c.location) if x]
    for l in c.links:
        if l.url:
            href = l.url if l.url.startswith(("http", "mailto")) else f"https://{l.url}"
            bits.append(f'<link href="{e(href)}" color="{lay.accent}">{e(l.url.replace("https://", "").replace("http://", "").rstrip("/"))}</link>')
    if bits:
        story.append(Paragraph("  |  ".join(bits), st["contact"]))

    def heading(title: str):
        story.append(Paragraph(_heading_markup(title, lay.heading_case, hs), st["h"]))
        if lay.heading_rule:
            story.append(HRFlowable(width="100%", thickness=0.6, color=accent, spaceBefore=1, spaceAfter=fs * 0.35))
        else:
            story.append(Spacer(1, fs * 0.25))

    def bullets(items: list[str]):
        # Real "•" characters (not drawn glyphs), so ATS parsers extract them as bullets.
        items = [i for i in items if i and i.strip()]
        return [Paragraph(e(i), st["li"], bulletText="•") for i in items] or None

    def entry(left_html: str, right_txt: str, sub: str = "", items: list[str] | None = None):
        row = Table([[Paragraph(left_html, st["role"]), Paragraph(e(right_txt), st["meta"])]], colWidths=[width * 0.7, width * 0.3])
        row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                 ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
        block = [row]
        if sub:
            block.append(Paragraph(e(sub), st["sub"]))
        if items and (b := bullets(items)):
            block.extend(b)
        block.append(Spacer(1, fs * 0.4))
        story.append(KeepTogether(block[:3]))
        story.extend(block[3:])

    if lay.show_summary and (s := (r.summary.tailored or r.summary.original)):
        heading("Summary")
        story.append(Paragraph(e(s), st["body"]))
    if r.skills.groups:
        heading("Skills")
        for g in r.skills.groups:
            label = f"<b>{e(g.category)}:</b> " if g.category else ""
            story.append(Paragraph(label + e(", ".join(g.items)), st["body"]))
    if r.experience:
        heading("Experience")
        for x in r.experience:
            left_html = e(x.title) + (f' <font name="{font}">— {e(x.company)}</font>' if x.company else "")
            entry(left_html, x.dates, x.location, [b.tailored or b.original for b in x.bullets])
    if r.projects:
        heading("Projects")
        for p in r.projects:
            left_html = e(p.name)
            if p.link:
                href = p.link if p.link.startswith("http") else f"https://{p.link}"
                left_html += f' <font name="{font}" size="{fs - 1:.1f}" color="{lay.accent}"><link href="{e(href)}">[link]</link></font>'
            entry(left_html, p.dates, ", ".join(p.tech), [b.tailored or b.original for b in p.bullets])
    if r.education:
        heading("Education")
        for ed in r.education:
            entry(e(ed.degree) + (f' <font name="{font}">— {e(ed.institution)}</font>' if ed.institution else ""),
                  ed.dates, ed.location, ed.details)
    if r.certifications:
        heading("Certifications")
        if b := bullets(r.certifications):
            story.extend(b)
    for sec in r.additional_sections:
        if sec.items:
            heading(sec.title or "Additional")
            if b := bullets(sec.items):
                story.extend(b)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=page, leftMargin=left, rightMargin=right, topMargin=top, bottomMargin=bottom,
                            title=f"{r.candidate.name} — Resume".strip(" —"), author=r.candidate.name or "", creator="Tailor")
    doc.build(story)
    return buf.getvalue(), doc.page


def letter_pdf(text: str, name: str = "") -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    font, _ = _register_fonts("sans")
    style = ParagraphStyle("p", fontName=font, fontSize=11, leading=16)
    story = []
    for para in [p for p in text.replace("\r", "").split("\n\n")]:
        if para.strip():
            story += [Paragraph(escape(para.strip()).replace("\n", "<br/>"), style), Spacer(1, 9)]
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=25 * mm, rightMargin=25 * mm, topMargin=25 * mm, bottomMargin=25 * mm,
                      title=f"Cover letter {name}".strip()).build(story)
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# DOCX
# --------------------------------------------------------------------------- #
def _docx_base(lay=None):
    import docx
    from docx.shared import Inches, Mm, Pt

    lay = _layout(lay)
    d = docx.Document()
    for sec in d.sections:
        if lay.page_size == "Letter":
            sec.page_width, sec.page_height = Inches(8.5), Inches(11)
        else:
            sec.page_width, sec.page_height = Mm(210), Mm(297)
        sec.left_margin, sec.right_margin = Inches(lay.margins.left), Inches(lay.margins.right)
        sec.top_margin, sec.bottom_margin = Inches(lay.margins.top), Inches(lay.margins.bottom)
    normal = d.styles["Normal"]
    normal.font.name = "Georgia" if lay.font_family == "serif" else "Calibri"
    normal.font.size = Pt(lay.font_size + 0.5)  # Word fonts run slightly smaller than PDF metrics
    normal.paragraph_format.space_after = Pt(0)
    normal.paragraph_format.line_spacing = max(1.0, lay.line_spacing * 0.85)
    return d


def resume_docx(r: TailoredResume, layout=None) -> bytes:
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    lay = _layout(layout)
    d = _docx_base(lay)
    hexc = lay.accent.lstrip("#")
    accent = RGBColor.from_string(hexc.upper())
    page_width = d.sections[0].page_width - d.sections[0].left_margin - d.sections[0].right_margin
    header_align = WD_ALIGN_PARAGRAPH.CENTER if lay.header_align == "center" else WD_ALIGN_PARAGRAPH.LEFT

    def para(text="", *, size=None, bold=False, color=None, align=None, after=0, before=0):
        p = d.add_paragraph()
        if text:
            run = p.add_run(text)
            run.bold = bold
            if size:
                run.font.size = Pt(size)
            if color:
                run.font.color.rgb = color
        if align is not None:
            p.alignment = align
        p.paragraph_format.space_after = Pt(after)
        p.paragraph_format.space_before = Pt(before)
        return p

    def heading(title: str):
        text = title.upper() if lay.heading_case == "upper" else title
        p = para(text, size=lay.heading_size + 0.5, bold=True, color=accent, before=9, after=3)
        if lay.heading_case == "smallcaps":
            p.runs[0].font.small_caps = True
        if lay.heading_rule:
            pPr = p._p.get_or_add_pPr()
            border = OxmlElement("w:pBdr")
            bottom = OxmlElement("w:bottom")
            for k, v in (("w:val", "single"), ("w:sz", "6"), ("w:space", "1"), ("w:color", hexc.upper())):
                bottom.set(qn(k), v)
            border.append(bottom)
            pPr.append(border)

    def bullet(text: str):
        p = d.add_paragraph(style="List Bullet")
        p.add_run(text)
        p.paragraph_format.space_after = Pt(1)

    def entry(left: str, company: str, right: str, sub: str, items: list[str]):
        p = para(before=3)
        p.paragraph_format.tab_stops.add_tab_stop(page_width, WD_TAB_ALIGNMENT.RIGHT)
        p.paragraph_format.keep_with_next = True
        p.add_run(left).bold = True
        if company:
            p.add_run(f" — {company}")
        if right:
            p.add_run(f"\t{right}").font.color.rgb = RGBColor(0x44, 0x44, 0x44)
        if sub:
            s = para(sub, size=lay.font_size, color=RGBColor(0x44, 0x44, 0x44))
            s.paragraph_format.keep_with_next = True
        for i in items:
            if i:
                bullet(i)

    if r.candidate.name:
        para(r.candidate.name, size=lay.name_size + 1, bold=True, color=accent, align=header_align)
    if r.candidate.headline:
        para(r.candidate.headline, size=lay.font_size + 1.5, align=header_align)
    c = r.candidate.contact
    if line := _join(c.email, c.phone, c.location, *[l.url for l in c.links], sep="  |  "):
        para(line, size=lay.font_size, align=header_align, after=2)

    if lay.show_summary and (s := (r.summary.tailored or r.summary.original)):
        heading("Summary")
        para(s)
    if r.skills.groups:
        heading("Skills")
        for g in r.skills.groups:
            p = para()
            if g.category:
                p.add_run(f"{g.category}: ").bold = True
            p.add_run(", ".join(g.items))
    if r.experience:
        heading("Experience")
        for x in r.experience:
            entry(x.title, x.company, x.dates, x.location, [b.tailored or b.original for b in x.bullets])
    if r.projects:
        heading("Projects")
        for pr in r.projects:
            entry(pr.name, "", pr.dates, _join(", ".join(pr.tech), pr.link), [b.tailored or b.original for b in pr.bullets])
    if r.education:
        heading("Education")
        for ed in r.education:
            entry(ed.degree, ed.institution, ed.dates, ed.location, ed.details)
    if r.certifications:
        heading("Certifications")
        for cert in r.certifications:
            bullet(cert)
    for sec in r.additional_sections:
        if sec.items:
            heading(sec.title or "Additional")
            for i in sec.items:
                bullet(i)

    d.core_properties.title = f"{r.candidate.name} Resume".strip()
    d.core_properties.author = r.candidate.name or ""
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def letter_docx(text: str, name: str = "") -> bytes:
    from docx.shared import Mm, Pt

    d = _docx_base()
    for s in d.sections:
        s.left_margin = s.right_margin = Mm(25)
        s.top_margin = s.bottom_margin = Mm(25)
    d.styles["Normal"].font.size = Pt(11)
    for para in text.replace("\r", "").split("\n\n"):
        if para.strip():
            p = d.add_paragraph(para.strip())
            p.paragraph_format.space_after = Pt(10)
    d.core_properties.title = f"Cover letter {name}".strip()
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()
