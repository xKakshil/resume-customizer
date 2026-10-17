"""Deterministic offline provider (LLM_PROVIDERS=mock).

Used by the test-suite and for running the full app without an API key. It
does a rule-based "tailoring" (re-ordering bullets by JD relevance, swapping
weak openers for action verbs, writing a templated summary) so every UI
feature — streaming, diff, scores, exports — can be exercised end-to-end.
It is NOT meant to produce production-quality rewrites.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator

from app.services.keywords import extract_jd_keywords, keyword_present, resume_skills
from app.services.llm.base import LLMProvider
from app.services.parsing import _HEADING_RE

_WEAK = [(r"^(was )?responsible for (developing|building)", "Developed"), (r"^(was )?responsible for", "Owned"),
         (r"^worked on", "Built"), (r"^helped (to )?", "Contributed to "), (r"^assisted (in|with)", "Supported"),
         (r"^involved in", "Contributed to"), (r"^participated in", "Contributed to")]


class MockProvider(LLMProvider):
    name = "mock"
    model = "rule-based-mock"

    def __init__(self, delay: float = 0.0):
        self._delay = delay

    async def complete(self, messages, *, json_mode=False, temperature=None) -> str:
        return self._respond(messages)

    async def stream(self, messages, *, temperature=None) -> AsyncIterator[str]:
        text = self._respond(messages)
        step = 24
        for i in range(0, len(text), step):
            if self._delay:
                await asyncio.sleep(self._delay)
            yield text[i:i + step]

    # ------------------------------------------------------------------ #
    def _respond(self, messages: list[dict]) -> str:
        system, user = messages[0]["content"], messages[-1]["content"]
        jd = _between(user, "job_description")
        resume = _between(user, "resume")
        if "cover letter" in system.lower():
            return _cover_letter(jd, resume)
        locked = set()
        m = re.search(r"Do NOT change ([^:]+):", system)
        if m:
            locked = {x.strip().lower() for x in m.group(1).split(",")}
        return json.dumps(_tailor(jd, resume, locked), ensure_ascii=False)


def _between(text: str, tag: str) -> str:
    m = re.search(rf"<{tag}>\n?(.*?)\n?</{tag}>", text, re.S)
    return m.group(1).strip() if m else ""


def _split_sections(resume: str) -> tuple[list[str], dict[str, list[str]]]:
    header: list[str] = []
    sections: dict[str, list[str]] = {}
    current = None
    for raw in resume.splitlines():
        line = raw.strip()
        if not line:
            continue
        cand = line.strip("•:|-").strip()
        key = next((k for k, rx in _HEADING_RE.items() if len(cand) <= 45 and rx.match(cand)), None)
        if key:
            current = key
            sections.setdefault(key, [])
            continue
        (sections[current] if current else header).append(line)
    return header, sections


def _entries(lines: list[str]) -> list[dict]:
    items: list[dict] = []
    for line in lines:
        if line.startswith("•"):
            if not items:
                items.append({"head": "", "bullets": []})
            items[-1]["bullets"].append(line.lstrip("• ").strip())
        elif items and not items[-1]["bullets"] and items[-1]["head"]:
            items[-1]["head"] += " | " + line
        else:
            items.append({"head": line, "bullets": []})
    return items


def _improve(bullet: str) -> str:
    out = bullet.strip()
    for pat, rep in _WEAK:
        new = re.sub(pat, rep, out, flags=re.I)
        if new != out:
            out = new.strip()
            break
    return out[0].upper() + out[1:] if out else out


def _tailor(jd: str, resume: str, locked: set[str]) -> dict:
    kws = extract_jd_keywords(jd)
    header, secs = _split_sections(resume)
    have = resume_skills(resume)
    matched = [k.name for k in kws if keyword_present(k.name, resume)]
    missing = [k for k in kws if not keyword_present(k.name, resume)]
    role = next((l.strip() for l in jd.splitlines() if l.strip()), "the role")[:60]

    def score(b: str) -> int:
        return sum(1 for k in matched if keyword_present(k, b))

    def bullets(bs: list[str], lock: bool) -> list[dict]:
        ordered = bs if lock else sorted(bs, key=lambda b: -score(b))
        return [{"original": b, "tailored": b if lock else _improve(b),
                 "keywords": [] if lock else [k for k in matched if keyword_present(k, b)]} for b in ordered]

    email = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", resume)
    phone = re.search(r"\+?\d[\d\s-]{8,}\d", resume)
    links = [{"label": "Link", "url": u} for u in re.findall(r"(?:https?://|www\.|linkedin\.com/|github\.com/)\S+", resume)[:4]]
    orig_summary = " ".join(secs.get("summary", []))
    top = ", ".join(matched[:4]) or "software development"
    tailored_summary = orig_summary if "summary" in locked else (
        f"Engineer targeting {role} with hands-on experience in {top}. "
        "Delivers reliable, well-tested features end to end and communicates clearly with cross-functional teams.")

    skill_lines = secs.get("skills", [])
    skill_items = [s.strip() for l in skill_lines for s in re.split(r"[,;|]", l.split(":", 1)[-1]) if s.strip()]
    groups = [{"category": (l.split(":", 1)[0].strip("• ") if ":" in l else "Skills"),
               "items": [s.strip() for s in re.split(r"[,;|]", l.split(":", 1)[-1]) if s.strip()]} for l in skill_lines]
    if "skills" not in locked:
        groups.sort(key=lambda g: -sum(1 for i in g["items"] if i.lower() in {m.lower() for m in matched} or i.lower() in have))

    exp = [{"title": e["head"], "company": "", "location": "", "dates": "",
            "bullets": bullets(e["bullets"], "experience" in locked), "rationale": "Bullets reordered by JD relevance."}
           for e in _entries(secs.get("experience", []))]
    proj = [{"name": e["head"], "tech": [], "dates": "", "link": "",
             "bullets": bullets(e["bullets"], "projects" in locked), "rationale": "Bullets reordered by JD relevance."}
            for e in _entries(secs.get("projects", []))]
    edu = [{"degree": l, "institution": "", "location": "", "dates": "", "details": []} for l in secs.get("education", [])]
    extra = [{"title": k.title(), "items": [l.lstrip("• ") for l in v]} for k, v in secs.items()
             if k in {"achievements", "positions", "publications"}]

    return {
        "jd_analysis": {"is_job_description": len(kws) > 0 or len(jd) > 300, "role_title": role, "company": "",
                        "seniority": "", "must_have": [k.name for k in kws if k.required][:10],
                        "nice_to_have": [k.name for k in kws if not k.required][:8], "responsibilities": []},
        "candidate": {"name": header[0] if header else "", "headline": role,
                      "contact": {"email": email.group(0) if email else "", "phone": phone.group(0).strip() if phone else "",
                                  "location": "", "links": links}},
        "summary": {"original": orig_summary, "tailored": tailored_summary, "rationale": "Aligned summary with the role."},
        "skills": {"original": skill_items, "groups": groups, "matched": matched, "rationale": "JD-relevant groups first."},
        "experience": exp,
        "projects": proj,
        "education": edu,
        "certifications": [l.lstrip("• ") for l in secs.get("certifications", [])],
        "additional_sections": extra,
        "missing_keywords": [{"keyword": k.name, "importance": "high" if k.required else "medium",
                              "suggestion": f"If you have used {k.name}, add it to a relevant bullet or your skills."} for k in missing[:10]],
        "change_log": ["Reordered bullets so JD-relevant work appears first.", "Rewrote weak bullet openers with action verbs.",
                       "Wrote a summary aligned to the target role."],
    }


def _cover_letter(jd: str, resume: str) -> str:
    name = next((l.strip() for l in resume.splitlines() if l.strip()), "Candidate")
    kws = [k.name for k in extract_jd_keywords(jd) if keyword_present(k.name, resume)][:3]
    skills = ", ".join(kws) or "building reliable software"
    return (f"Dear Hiring Manager,\n\nI'm applying for this role because it lines up closely with the work I've been doing in {skills}.\n\n"
            "Across my projects and internships I've shipped features end to end, from API design to deployment, and I care about "
            "writing clear, tested code that teammates can build on.\n\nI'd welcome the chance to discuss how I can contribute to your team.\n\n"
            f"Sincerely,\n{name}")
