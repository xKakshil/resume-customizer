"""Job-description clean-up.

JDs are usually copy-pasted from job boards and arrive with UI chrome and legal
boilerplate ("Apply now", "Equal Opportunity Employer", "Show more", "Posted 3
days ago"). Those lines waste tokens and add false keywords (EEO, PTO, ...).
We drop them conservatively — only lines that are *entirely* boilerplate — and
collapse duplicated lines that job boards often repeat.
"""

from __future__ import annotations

import re

_NOISE = [
    r"^(apply|apply now|easy apply|quick apply|save|save job|share|share this job|report( this)? job|show (more|less)|see more|read more|view job|back to (search|jobs))\.?$",
    r"^click here\b",
    r"equal (employment )?opportunity employer",
    r"\b(we are|is) an? (eoe|equal opportunity)",
    r"does not discriminate (on the basis|against)",
    r"(race|religion|colou?r|national origin|sexual orientation|gender identity|veteran status|disability)(,| or| and).*(race|religion|colou?r|national origin|sexual orientation|gender identity|veteran status|disability)",
    r"reasonable accommodation",
    r"drug[- ]free workplace",
    r"^(privacy policy|terms (and|&) conditions|cookie (policy|settings))",
    r"^(job|requisition|req)[ -]?(id|number|no\.?)\s*[:#]",
    r"^(posted|reposted)\s+(\d+|a|an|one)\s+(minute|hour|day|week|month)s?\s+ago",
    r"^\d+\+?\s+(applicants|people clicked apply)",
    r"^(be an early applicant|see who you know|meet the hiring team|promoted|actively recruiting)\b",
    r"^(seniority level|employment type|job function|industries)\s*$",
]
_NOISE_RE = [re.compile(p, re.I) for p in _NOISE]


def clean_jd(text: str) -> tuple[str, int]:
    """Return (cleaned_text, number_of_lines_removed)."""
    out: list[str] = []
    removed = 0
    prev = None
    for raw in (text or "").replace("\r\n", "\n").split("\n"):
        line = re.sub(r"[ \t]+", " ", raw).strip()
        if line and any(rx.search(line) for rx in _NOISE_RE) and len(line) < 400:
            removed += 1
            continue
        if line and prev is not None and line.lower() == prev.lower():
            removed += 1  # job boards often duplicate the title/company line
            continue
        out.append(line)
        if line:
            prev = line
    cleaned = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()
    return cleaned, removed
