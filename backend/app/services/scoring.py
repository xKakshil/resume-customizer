"""Heuristic ATS-friendliness score.

Real ATS products differ, but they agree on the fundamentals: parseable text,
standard section headings, contact details, keyword coverage, and concise,
quantified, action-led bullet points. Each check below is transparent: it
reports what was measured and a concrete tip, so the score is actionable rather
than a magic number.
"""

from __future__ import annotations

import re

from app.services.parsing import detect_sections

ACTION_VERBS = {
    "accelerated", "achieved", "added", "administered", "analyzed", "analysed", "architected", "assembled", "assessed",
    "automated", "boosted", "built", "championed", "coded", "collaborated", "configured", "consolidated", "constructed",
    "contributed", "converted", "coordinated", "created", "cut", "debugged", "decreased", "defined", "delivered",
    "deployed", "designed", "developed", "devised", "diagnosed", "directed", "documented", "doubled", "drove", "eliminated",
    "enabled", "engineered", "enhanced", "established", "evaluated", "executed", "expanded", "expedited", "extended",
    "facilitated", "fixed", "founded", "generated", "grew", "guided", "halved", "handled", "headed", "identified",
    "implemented", "improved", "increased", "initiated", "innovated", "installed", "integrated", "introduced", "invented",
    "investigated", "launched", "led", "leveraged", "maintained", "managed", "mentored", "merged", "migrated", "minimized",
    "modeled", "modelled", "modernized", "monitored", "negotiated", "optimized", "optimised", "orchestrated", "organized",
    "overhauled", "owned", "partnered", "performed", "piloted", "pioneered", "planned", "presented", "prioritized",
    "produced", "programmed", "prototyped", "provisioned", "published", "raised", "rebuilt", "reduced", "refactored",
    "redesigned", "re-architected", "released", "remediated", "replaced", "researched", "resolved", "restructured",
    "revamped", "saved", "scaled", "scripted", "secured", "shipped", "simplified", "solved", "spearheaded", "standardized",
    "streamlined", "strengthened", "structured", "supervised", "supported", "surpassed", "tested", "trained", "transformed",
    "translated", "tripled", "troubleshot", "unified", "upgraded", "utilized", "validated", "won", "wrote", "conducted",
    "won", "ranked", "secured", "awarded", "authored", "co-authored", "taught", "volunteered", "organised", "coordinated",
    "crafted", "curated", "containerized", "instrumented", "benchmarked", "parallelized", "productionized",
}
WEAK_STARTS = ("responsible for", "worked on", "helped", "assisted", "involved in", "duties included", "tasked with", "participated in")
BUZZWORDS = ("hardworking", "hard-working", "go-getter", "synergy", "self-starter", "team player", "think outside the box",
             "detail-oriented", "results-driven", "dynamic individual", "passionate individual", "best of breed")

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{4,5}")
_PROFILE = re.compile(r"linkedin\.com|github\.com|gitlab\.com|portfolio|behance\.net|dribbble\.com|leetcode\.com|kaggle\.com|https?://", re.I)
_NUMBER = re.compile(r"\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|double|triple|half)\b", re.I)
_DATE = re.compile(r"\b(19|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*'?\d{2,4}\b|\bpresent\b", re.I)
_FIRST_PERSON = re.compile(r"\b(I|me|my|mine|myself)\b")


def _bullets(text: str) -> list[str]:
    return [l[1:].strip() for l in (x.strip() for x in text.splitlines()) if l.startswith("•") and len(l) > 3]


def _check(cid: str, label: str, score: float, max_score: float, detail: str, tip: str | None = None) -> dict:
    ratio = score / max_score if max_score else 1
    status = "pass" if ratio >= 0.8 else "warn" if ratio >= 0.4 else "fail"
    return {"id": cid, "label": label, "score": round(score, 1), "max": max_score, "status": status,
            "detail": detail, "tip": tip if status != "pass" else None}


def ats_score(text: str, keyword_match: int | None) -> dict:
    checks: list[dict] = []
    words = len(text.split())
    bullets = _bullets(text)
    sections = set(detect_sections(text))

    # 1. Contact information (10)
    has_email, has_phone, has_link = bool(_EMAIL.search(text)), bool(_PHONE.search(text[:600])), bool(_PROFILE.search(text))
    s = 4 * has_email + 3 * has_phone + 3 * has_link
    missing = [n for n, ok in (("email", has_email), ("phone", has_phone), ("LinkedIn/GitHub/portfolio link", has_link)) if not ok]
    checks.append(_check("contact", "Contact details", s, 10,
                         "Email, phone and profile link found." if not missing else f"Missing: {', '.join(missing)}.",
                         "Put email, phone and a LinkedIn/GitHub link in the header as plain text."))

    # 2. Standard sections (15)
    s = 0.0
    s += 6 if ({"experience", "projects"} & sections) else 0
    s += 4 if "education" in sections else 0
    s += 5 if "skills" in sections else 0
    found = sorted(sections) or ["none"]
    checks.append(_check("sections", "Standard section headings", s, 15, f"Detected: {', '.join(found)}.",
                         "Use conventional headings — Summary, Experience, Projects, Education, Skills — so parsers can map your content."))

    # 3. Keyword match (30)
    if keyword_match is None:
        checks.append(_check("keywords", "Job-description keyword coverage", 15, 30,
                             "The job description has few recognisable hard skills, so keyword coverage is estimated.",
                             "Paste the full job description including the requirements section."))
    else:
        checks.append(_check("keywords", "Job-description keyword coverage", 30 * keyword_match / 100, 30,
                             f"{keyword_match}% of weighted JD keywords appear in the resume.",
                             "Mirror the JD's exact wording for skills you genuinely have (e.g. 'PostgreSQL', not just 'SQL databases')."))

    # 4–6. Bullet quality
    if bullets:
        strong = sum(1 for b in bullets if b.split()[0].lower().strip(",.:;") in ACTION_VERBS)
        weak = sum(1 for b in bullets if b.lower().startswith(WEAK_STARTS))
        r = max(0.0, (strong - 0.5 * weak) / len(bullets))
        checks.append(_check("action_verbs", "Bullets start with action verbs", 10 * min(1, r / 0.7), 10,
                             f"{strong}/{len(bullets)} bullets start with a strong verb" + (f"; {weak} start with weak phrases like 'Responsible for'." if weak else "."),
                             "Lead every bullet with a past-tense action verb: Built, Reduced, Led, Automated…"))
        q = sum(1 for b in bullets if _NUMBER.search(b)) / len(bullets)
        checks.append(_check("quantified", "Quantified impact", 10 * min(1, q / 0.5), 10,
                             f"{round(q * 100)}% of bullets include a number, metric or scale.",
                             "Add measurable outcomes where true: latency cut by 40%, 10k users, 3× faster builds."))
        good_len = sum(1 for b in bullets if 8 <= len(b.split()) <= 40) / len(bullets)
        checks.append(_check("bullet_length", "Concise bullet points", 5 * good_len, 5,
                             f"{round(good_len * 100)}% of bullets are 8–40 words.",
                             "Keep bullets to one or two lines; split long ones and expand fragments."))
    else:
        checks.append(_check("action_verbs", "Bullets start with action verbs", 0, 10, "No bullet points detected.",
                             "Describe experience and projects as bullet points starting with action verbs."))
        checks.append(_check("quantified", "Quantified impact", 2 if _NUMBER.search(text) else 0, 10, "No bullet points to evaluate.",
                             "Add measurable outcomes to each role or project."))
        checks.append(_check("bullet_length", "Concise bullet points", 0, 5, "No bullet points detected.",
                             "Use short bullet points rather than paragraphs."))

    # 7. Length (5)
    if 300 <= words <= 900:
        s, d = 5, f"{words} words — a good length."
    elif 200 <= words < 300 or 900 < words <= 1200:
        s, d = 3, f"{words} words — " + ("a bit thin." if words < 300 else "a bit long.")
    else:
        s, d = 1, f"{words} words — " + ("too short." if words < 200 else "too long.")
    checks.append(_check("length", "Resume length", s, 5, d, "Aim for roughly 400–800 words (one page early-career, two pages max)."))

    # 8. Writing style (5)
    fp = len(_FIRST_PERSON.findall("\n".join(bullets) if bullets else text))
    bz = [b for b in BUZZWORDS if b in text.lower()]
    s = max(0, 5 - min(3, fp) - min(2, len(bz)))
    detail = "No first-person pronouns or empty buzzwords." if s == 5 else \
        "; ".join(x for x in (f"{fp} first-person pronoun(s) in bullets" if fp else "", f"buzzwords: {', '.join(bz)}" if bz else "") if x) + "."
    checks.append(_check("style", "Professional writing style", s, 5, detail,
                         "Drop 'I/my' from bullets and replace buzzwords with evidence."))

    # 9. Parseability (10)
    long_lines = sum(1 for l in text.splitlines() if len(l) > 220)
    odd = sum(1 for ch in text if ord(ch) > 0x2FFF) / max(1, len(text))
    dates = len(_DATE.findall(text))
    s = 10.0
    issues = []
    if long_lines > 2:
        s -= 4; issues.append(f"{long_lines} very long lines (possible multi-column layout merging)")
    if odd > 0.01:
        s -= 3; issues.append("unusual symbols/icons that ATS may garble")
    if dates < 2:
        s -= 3; issues.append("few recognisable dates")
    checks.append(_check("parseability", "ATS parseability", s, 10,
                         "Text extracts cleanly with recognisable dates." if not issues else "Found " + "; ".join(issues) + ".",
                         "Prefer a single-column layout, standard fonts, plain-text icons, and dates like 'Jan 2024 – Present'."))

    total = round(sum(c["score"] for c in checks))
    grade = "Excellent" if total >= 85 else "Good" if total >= 70 else "Fair" if total >= 50 else "Needs work"
    return {"score": total, "grade": grade, "checks": checks}
