"""AI chat that *proposes* edits to the tailored resume (nothing is applied
until the user accepts). Proposals go through the same guardrails and scoring
as the main tailoring step, so a chat edit can't sneak in invented facts."""

from __future__ import annotations

import time

from pydantic import ValidationError

from app.core.errors import LLMError
from app.models.schemas import ChatRequest, LayoutSettings, TailoredResume, TailorRequest
from app.services import keywords as kw
from app.services.llm.factory import get_chain
from app.services.prompts import CHAT_CONTENT_KEYS, build_chat_messages
from app.services.tailor import apply_guardrails, extract_json, finalize, validate_inputs

_LAYOUT_KEYS = set(LayoutSettings.model_fields)


def _restore_originals(prev: TailoredResume, new: TailoredResume) -> None:
    """`original` fields are the uploaded text; the model may not change them."""
    new.summary.original = prev.summary.original
    new.skills.original = prev.skills.original
    known = {b.original for item in [*prev.experience, *prev.projects] for b in item.bullets if b.original}
    for item in [*new.experience, *new.projects]:
        for b in item.bullets:
            if b.original and b.original not in known:
                b.original = ""


def _merge_layout(current: LayoutSettings, patch: dict | None) -> LayoutSettings | None:
    if not isinstance(patch, dict):
        return None
    data = current.model_dump()
    changed = False
    for k, v in patch.items():
        if k not in _LAYOUT_KEYS:
            continue
        if k == "margins" and isinstance(v, dict):
            for side, val in v.items():
                if side in data["margins"]:
                    try:
                        data["margins"][side] = min(1.5, max(0.3, float(val)))
                        changed = True
                    except (TypeError, ValueError):
                        pass
        else:
            data[k] = v
            changed = True
    if not changed:
        return None
    try:
        new = LayoutSettings.model_validate(data)
    except ValidationError:
        return None
    return new if new != current else None


def _diff(prev: TailoredResume, new: TailoredResume, show_before: bool, show_after: bool) -> list[dict]:
    out: list[dict] = []
    b_sum = (prev.summary.tailored or prev.summary.original) if show_before else ""
    a_sum = (new.summary.tailored or new.summary.original) if show_after else ""
    if b_sum.strip() != a_sum.strip():
        out.append({"path": "summary", "label": "Summary", "before": b_sum, "after": a_sum})
    bs = {g.category: ", ".join(g.items) for g in prev.skills.groups}
    for g in new.skills.groups:
        if bs.get(g.category, None) != ", ".join(g.items):
            out.append({"path": f"skills.{g.category}", "label": f"Skills · {g.category or 'Skills'}", "before": bs.get(g.category, ""), "after": ", ".join(g.items)})
    for key, label in (("experience", "title"), ("projects", "name")):
        old_items, new_items = getattr(prev, key), getattr(new, key)
        for i in range(max(len(old_items), len(new_items))):
            o = old_items[i] if i < len(old_items) else None
            n = new_items[i] if i < len(new_items) else None
            name = getattr(n or o, label, "") or key.title()
            ob = [b.tailored or b.original for b in (o.bullets if o else [])]
            nb = [b.tailored or b.original for b in (n.bullets if n else [])]
            for j in range(max(len(ob), len(nb))):
                before = ob[j] if j < len(ob) else ""
                after = nb[j] if j < len(nb) else ""
                if before.strip() != after.strip():
                    out.append({"path": f"{key}.{i}.{j}", "label": f"{name} · bullet {j + 1}", "before": before, "after": after})
    return out


async def chat(req: ChatRequest) -> dict:
    started = time.perf_counter()
    jd, resume_text = validate_inputs(req.job_description, req.resume_text)
    messages = build_chat_messages(req.message, [t.model_dump() for t in req.history], req.resume.model_dump(),
                                   req.layout.model_dump(), jd, resume_text,
                                   [c.model_dump() for c in req.confirmed_skills], [d.model_dump() for d in req.supporting_documents])
    data, provider = None, None
    for temperature in (0.3, 0.0):
        text, provider = await get_chain().complete(messages, json_mode=True, temperature=temperature)
        try:
            data = extract_json(text)
            if isinstance(data, dict) and isinstance(data.get("reply", ""), str):
                break
        except ValueError:
            data = None
    if not isinstance(data, dict):
        raise LLMError("The AI's answer was incomplete. Please try asking again.", code="llm_bad_output")

    reply = str(data.get("reply") or "").strip() or "Done."
    changes = [str(c) for c in (data.get("changes") or []) if str(c).strip()][:12]
    layout = _merge_layout(req.layout, data.get("layout"))
    show_after = (layout or req.layout).show_summary

    result = None
    diff: list[dict] = []
    if isinstance(data.get("resume"), dict):
        merged = req.resume.model_dump()
        for k in CHAT_CONTENT_KEYS:
            if k in data["resume"] and data["resume"][k] is not None:
                merged[k] = data["resume"][k]
        try:
            new = TailoredResume.model_validate(merged)
        except ValidationError:
            new = None
        if new is not None:
            _restore_originals(req.resume, new)
            sections = list(dict.fromkeys([*req.sections, *(["summary"] if show_after else [])]))
            if not show_after:
                sections = [s for s in sections if s != "summary"]
            treq = TailorRequest(job_description=jd, resume_text=resume_text, sections=sections or ["experience"],
                                 confirmed_skills=req.confirmed_skills, supporting_documents=req.supporting_documents)
            jd_keywords = kw.extract_jd_keywords(jd)
            guard = apply_guardrails(new, treq, resume_text, jd_keywords, jd)
            diff = _diff(req.resume, new, req.layout.show_summary, show_after)
            if diff or new.model_dump() != req.resume.model_dump():
                result = finalize(new, treq, jd, resume_text, jd_keywords, guard, provider.name, provider.model, started)
                result["meta"]["tone"] = "balanced"
                result["meta"]["source"] = "chat"

    proposal = None
    if result is not None or layout is not None:
        proposal = {"result": result, "layout": layout.model_dump() if layout else None, "diff": diff}
    return {"reply": reply, "changes": changes, "proposal": proposal, "provider": provider.name, "model": provider.model}
