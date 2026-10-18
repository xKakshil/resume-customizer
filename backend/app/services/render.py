"""Render a TailoredResume to plain text or Markdown (used for scoring, TXT/MD export and history)."""

from __future__ import annotations

from app.models.schemas import TailoredResume


def _join(*parts: str, sep: str = " | ") -> str:
    return sep.join(p.strip() for p in parts if p and p.strip())


def contact_line(r: TailoredResume) -> str:
    c = r.candidate.contact
    return _join(c.email, c.phone, c.location, *[l.url for l in c.links])


def to_text(r: TailoredResume, *, tailored: bool = True, include_summary: bool = True) -> str:
    out: list[str] = []
    pick = (lambda b: b.tailored or b.original) if tailored else (lambda b: b.original or b.tailored)
    if r.candidate.name:
        out.append(r.candidate.name)
    if r.candidate.headline:
        out.append(r.candidate.headline)
    if line := contact_line(r):
        out.append(line)

    summary = ((r.summary.tailored or r.summary.original) if tailored else r.summary.original) if include_summary else ""
    if summary:
        out += ["", "SUMMARY", summary]

    if r.skills.groups:
        out += ["", "SKILLS"]
        out += [f"{g.category}: {', '.join(g.items)}" if g.category else ", ".join(g.items) for g in r.skills.groups if g.items]
    elif r.skills.original:
        out += ["", "SKILLS", ", ".join(r.skills.original)]

    if r.experience:
        out += ["", "EXPERIENCE"]
        for e in r.experience:
            out.append(_join(_join(e.title, e.company, sep=" — "), e.location, e.dates))
            out += [f"• {pick(b)}" for b in e.bullets if pick(b)]
    if r.projects:
        out += ["", "PROJECTS"]
        for p in r.projects:
            out.append(_join(p.name, ", ".join(p.tech), p.dates, p.link))
            out += [f"• {pick(b)}" for b in p.bullets if pick(b)]
    if r.education:
        out += ["", "EDUCATION"]
        for ed in r.education:
            out.append(_join(_join(ed.degree, ed.institution, sep=" — "), ed.location, ed.dates))
            out += [f"• {d}" for d in ed.details if d]
    if r.certifications:
        out += ["", "CERTIFICATIONS"] + [f"• {c}" for c in r.certifications if c]
    for sec in r.additional_sections:
        if sec.items:
            out += ["", sec.title.upper() or "ADDITIONAL"] + [f"• {i}" for i in sec.items if i]
    return "\n".join(out).strip()


def to_markdown(r: TailoredResume, *, include_summary: bool = True) -> str:
    md: list[str] = []
    if r.candidate.name:
        md.append(f"# {r.candidate.name}")
    if r.candidate.headline:
        md.append(f"**{r.candidate.headline}**")
    if line := contact_line(r):
        md.append(line)
    if include_summary and (s := (r.summary.tailored or r.summary.original)):
        md += ["", "## Summary", s]
    if r.skills.groups:
        md += ["", "## Skills"] + [f"- **{g.category}:** {', '.join(g.items)}" if g.category else f"- {', '.join(g.items)}"
                                   for g in r.skills.groups if g.items]
    if r.experience:
        md += ["", "## Experience"]
        for e in r.experience:
            md += ["", f"### {_join(e.title, e.company, sep=' — ')}"]
            if meta := _join(e.location, e.dates):
                md.append(f"*{meta}*")
            md += [f"- {b.tailored or b.original}" for b in e.bullets]
    if r.projects:
        md += ["", "## Projects"]
        for p in r.projects:
            md += ["", f"### {p.name}"]
            if meta := _join(", ".join(p.tech), p.dates, p.link):
                md.append(f"*{meta}*")
            md += [f"- {b.tailored or b.original}" for b in p.bullets]
    if r.education:
        md += ["", "## Education"]
        for ed in r.education:
            md.append(f"- **{_join(ed.degree, ed.institution, sep=' — ')}** {_join(ed.location, ed.dates)}".rstrip())
            md += [f"  - {d}" for d in ed.details]
    if r.certifications:
        md += ["", "## Certifications"] + [f"- {c}" for c in r.certifications]
    for sec in r.additional_sections:
        if sec.items:
            md += ["", f"## {sec.title or 'Additional'}"] + [f"- {i}" for i in sec.items]
    return "\n".join(md).strip() + "\n"
