"""Tailoring pipeline: validate → prompt → LLM → robust JSON parse → guardrails → scores.

Guardrails are deterministic post-processing that don't trust the model:
- sections the user locked are restored to their originals (text *and* order);
- skills the resume doesn't evidence are stripped from the skills list and moved
  to "missing keywords";
- rewritten bullets that introduce numbers or technologies absent from the
  original resume are flagged for the user to verify;
- "missing" keywords the resume actually contains are removed.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from pydantic import ValidationError

from app.config import get_settings
from app.core.errors import InvalidInputError, LLMError
from app.models.schemas import Bullet, MissingKeyword, TailoredResume, TailorRequest
from app.services import keywords as kw
from app.services.llm.factory import get_chain
from app.services.prompts import build_tailor_messages
from app.services.render import to_text
from app.services.scoring import ats_score

_NUM_RE = re.compile(r"\d+(?:[.,]\d+)?")


# --------------------------------------------------------------------------- #
# Input validation
# --------------------------------------------------------------------------- #
def validate_inputs(jd: str, resume: str) -> tuple[str, str]:
    s = get_settings()
    jd, resume = (jd or "").strip(), (resume or "").strip()
    if not jd:
        raise InvalidInputError("Please paste the job description.", code="jd_empty")
    if len(jd) < s.min_jd_chars:
        raise InvalidInputError(f"The job description is too short ({len(jd)} characters). Paste the full posting — at least {s.min_jd_chars} characters.", code="jd_too_short")
    if len(jd) > s.max_jd_chars:
        raise InvalidInputError(f"The job description is too long ({len(jd):,} characters). Please keep it under {s.max_jd_chars:,}.", code="jd_too_long")
    if len(set(jd.lower().split())) < 15:
        raise InvalidInputError("This doesn't look like a job description. Please paste the full posting text.", code="not_a_jd")
    if not resume:
        raise InvalidInputError("Please upload your resume first.", code="resume_empty")
    if len(resume) < s.min_resume_chars:
        raise InvalidInputError("The resume text is too short to tailor.", code="resume_too_short")
    return jd, resume[: s.max_resume_chars]


# --------------------------------------------------------------------------- #
# JSON handling
# --------------------------------------------------------------------------- #
def extract_json(text: str) -> dict:
    """Parse model output that *should* be JSON but may be wrapped in fences or prose."""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.I)
    start, end = t.find("{"), t.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object found")
    candidate = t[start:end + 1]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        repaired = re.sub(r",\s*([}\]])", r"\1", candidate)  # trailing commas
        return json.loads(repaired, strict=False)  # strict=False tolerates raw newlines inside strings


def parse_tailored(text: str) -> TailoredResume:
    try:
        return TailoredResume.model_validate(extract_json(text))
    except (ValueError, ValidationError) as exc:
        raise LLMError("The AI returned an incomplete response.", code="llm_bad_output") from exc


async def _repair_via_llm(req: TailorRequest, jd: str, resume: str) -> tuple[TailoredResume, str, str]:
    """Second attempt in strict JSON mode with lower temperature."""
    messages = build_tailor_messages(jd, resume, req.sections, req.tone, req.extra_instructions)
    for temp in (0.2, 0.0):
        text, provider = await get_chain().complete(messages, json_mode=True, temperature=temp)
        try:
            return parse_tailored(text), provider.name, provider.model
        except LLMError:
            continue
    raise LLMError("The AI returned an invalid response twice. Please try again.", code="llm_bad_output")


# --------------------------------------------------------------------------- #
# Guardrails
# --------------------------------------------------------------------------- #
def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9+#.]+", " ", s.lower()).strip()


def _evidenced(item: str, resume: str, resume_lex: set[str]) -> bool:
    """Is a skill string supported by the resume text?"""
    lex = kw.resume_skills(item)
    if lex:
        return lex <= resume_lex or _norm(item) in _norm(resume)
    if _norm(item) in _norm(resume):
        return True
    tokens = [t for t in _norm(item).split() if len(t) > 2]
    return bool(tokens) and all(t in _norm(resume) for t in tokens)


def _restore_order(bullets: list[Bullet], resume: str) -> list[Bullet]:
    low = resume.lower()

    def pos(b: Bullet) -> int:
        probe = b.original.lower().strip()[:40]
        i = low.find(probe) if probe else -1
        return i if i >= 0 else 10**9

    return sorted(bullets, key=pos)


def apply_guardrails(r: TailoredResume, req: TailorRequest, resume: str, jd_keywords: list[kw.WeightedKeyword]) -> dict:
    report = {"removed_skills": [], "flagged_bullets": 0, "locked_sections": [s for s in ("summary", "skills", "experience", "projects") if s not in req.sections]}
    resume_lex = kw.resume_skills(resume)
    resume_nums = set(_NUM_RE.findall(resume))

    # 1. Locked sections → originals.
    if "summary" not in req.sections:
        r.summary.tailored = r.summary.original
        r.summary.rationale = ""
    for key in ("experience", "projects"):
        if key not in req.sections:
            for item in getattr(r, key):
                for b in item.bullets:
                    b.tailored, b.keywords = b.original, []
                item.bullets = _restore_order(item.bullets, resume)
                item.rationale = ""

    # 2. Skills must be evidenced by the resume.
    missing_names = {m.keyword.lower() for m in r.missing_keywords}
    for g in r.skills.groups:
        kept = []
        for item in g.items:
            if _evidenced(item, resume, resume_lex):
                kept.append(item)
            else:
                report["removed_skills"].append(item)
                if item.lower() not in missing_names:
                    r.missing_keywords.append(MissingKeyword(keyword=item, importance="medium",
                                                             suggestion=f"Add {item} only if you have real experience with it."))
                    missing_names.add(item.lower())
        g.items = list(dict.fromkeys(kept))
    r.skills.groups = [g for g in r.skills.groups if g.items]
    r.skills.matched = [m for m in r.skills.matched if _evidenced(m, resume, resume_lex)]

    # 3. Flag bullets that introduce unverified numbers / technologies.
    for item in [*r.experience, *r.projects]:
        for b in item.bullets:
            if not b.tailored or b.tailored == b.original:
                continue
            new_nums = set(_NUM_RE.findall(b.tailored)) - set(_NUM_RE.findall(b.original)) - resume_nums
            new_tech = kw.resume_skills(b.tailored) - kw.resume_skills(b.original) - resume_lex
            flags = []
            if new_nums:
                flags.append("unverified_number:" + ",".join(sorted(new_nums)))
            if new_tech:
                flags.append("unverified_skill:" + ",".join(sorted(new_tech)))
            if flags:
                b.flags = flags
                report["flagged_bullets"] += 1

    # 4. Clean missing keywords: drop ones the resume has, dedupe, sort by importance.
    seen, cleaned = set(), []
    for m in r.missing_keywords:
        k = m.keyword.strip()
        if not k or k.lower() in seen or kw.keyword_present(k, resume):
            continue
        seen.add(k.lower())
        cleaned.append(m)
    order = {"high": 0, "medium": 1, "low": 2}
    r.missing_keywords = sorted(cleaned, key=lambda m: order[m.importance])[:15]
    return report


# --------------------------------------------------------------------------- #
# Scoring + result
# --------------------------------------------------------------------------- #
def compute_scores(jd: str, resume_text: str, tailored_text: str | None = None, jd_keywords=None) -> dict:
    jd_keywords = jd_keywords if jd_keywords is not None else kw.extract_jd_keywords(jd)
    before = kw.match_score(jd_keywords, resume_text)
    result = {"match": {"before": before}, "ats": {"before": ats_score(resume_text, before["score"])}}
    if tailored_text is not None:
        after = kw.match_score(jd_keywords, tailored_text)
        result["match"]["after"] = after
        result["ats"]["after"] = ats_score(tailored_text, after["score"])
    return result


def build_result(r: TailoredResume, req: TailorRequest, jd: str, resume: str, provider: str, model: str, started: float) -> dict:
    if not r.jd_analysis.is_job_description:
        raise InvalidInputError("The text you pasted doesn't look like a job description. Please paste the job posting.", code="not_a_jd")
    if not (r.experience or r.projects or r.education or r.skills.groups):
        raise LLMError("The AI couldn't find resume content to tailor. Check that the uploaded file is your resume.", code="llm_empty_resume")
    jd_keywords = kw.extract_jd_keywords(jd)
    guard = apply_guardrails(r, req, resume, jd_keywords)
    tailored_text = to_text(r)
    return {
        "resume": r.model_dump(),
        "tailored_text": tailored_text,
        "scores": compute_scores(jd, resume, tailored_text, jd_keywords),
        "guardrails": guard,
        "meta": {"provider": provider, "model": model, "tone": req.tone, "sections": req.sections,
                 "duration_ms": int((time.perf_counter() - started) * 1000),
                 "created_at": datetime.now(timezone.utc).isoformat()},
    }


# --------------------------------------------------------------------------- #
# Entry points
# --------------------------------------------------------------------------- #
async def tailor(req: TailorRequest) -> dict:
    started = time.perf_counter()
    jd, resume = validate_inputs(req.job_description, req.resume_text)
    messages = build_tailor_messages(jd, resume, req.sections, req.tone, req.extra_instructions)
    text, provider = await get_chain().complete(messages, json_mode=True)
    try:
        r, pname, pmodel = parse_tailored(text), provider.name, provider.model
    except LLMError:
        r, pname, pmodel = await _repair_via_llm(req, jd, resume)
    return build_result(r, req, jd, resume, pname, pmodel, started)


async def tailor_stream(req: TailorRequest) -> AsyncIterator[tuple[str, dict]]:
    """Yields (event, data) tuples for SSE: status / delta / result."""
    started = time.perf_counter()
    jd, resume = validate_inputs(req.job_description, req.resume_text)
    yield "status", {"stage": "analyzing", "message": "Analysing the job description"}
    messages = build_tailor_messages(jd, resume, req.sections, req.tone, req.extra_instructions)

    buf: list[str] = []
    provider = None
    async for kind, value in get_chain().stream(messages):
        if kind == "provider":
            provider = value
            yield "status", {"stage": "writing", "message": "Rewriting your resume", "provider": value.name, "model": value.model}
        else:
            buf.append(value)
            yield "delta", {"text": value}

    yield "status", {"stage": "validating", "message": "Checking facts and scoring"}
    try:
        r, pname, pmodel = parse_tailored("".join(buf)), provider.name, provider.model
    except LLMError:
        yield "status", {"stage": "repairing", "message": "Fixing an incomplete AI response"}
        r, pname, pmodel = await _repair_via_llm(req, jd, resume)
    yield "result", build_result(r, req, jd, resume, pname, pmodel, started)
