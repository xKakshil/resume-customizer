"""Prompt-quality evaluation harness.

Runs the real tailoring pipeline (whatever LLM_PROVIDERS is configured) over a
set of job descriptions and reports objective, reproducible metrics per run:

- validity      the model's first answer parsed as our schema (no repair round-trip)
- match Δ / ATS Δ  deterministic score change (same scorer before/after)
- truthfulness  skills the guardrail had to strip, bullets flagged for new numbers/tools,
                invented dates/locations removed — all of these should be 0
- preservation  every original bullet kept; summary 40–70 words
- style         % of bullets opening with an action verb; avg bullet length
- stuffing      max times one JD keyword appears across bullets (should be ≤ 2–3)

Optionally (--judge) a second LLM call grades each output 1–5 on truthfulness,
relevance and readability, LLM-as-judge style, with a short reason.

Usage (from backend/):
    python -m evals.run_eval                      # all JDs × sample resume
    python -m evals.run_eval --tone impact --judge
    python -m evals.run_eval --resume path/to/resume.pdf
Writes evals/report.md and prints a summary table.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))

from app.models.schemas import TailorRequest  # noqa: E402
from app.services import keywords as kw  # noqa: E402
from app.services import tailor as pipeline  # noqa: E402
from app.services.llm.factory import get_chain  # noqa: E402
from app.services.parsing import parse_resume  # noqa: E402
from app.services.scoring import ACTION_VERBS  # noqa: E402

JUDGE_PROMPT = """You are auditing an AI resume-tailoring tool. Compare the ORIGINAL resume with the TAILORED one for the given JOB.
Score each criterion from 1 (poor) to 5 (excellent):
- truthfulness: the tailored resume claims nothing (skills, numbers, scope, titles, dates) that the original does not support.
- relevance: the most JD-relevant experience is foregrounded and the JD's language is used where truthful.
- readability: bullets are concise, start with strong verbs, and read like a strong human-written resume.
Return JSON only: {"truthfulness": int, "relevance": int, "readability": int, "reason": "one or two sentences"}"""


def _bullets(resume: dict) -> list[dict]:
    return [b for sec in ("experience", "projects") for item in resume[sec] for b in item["bullets"]]


def metrics(result: dict, jd: str, repaired: bool) -> dict:
    r = result["resume"]
    bullets = _bullets(r)
    texts = [b["tailored"] or b["original"] for b in bullets]
    words = [len(t.split()) for t in texts] or [0]
    verbs = sum(1 for t in texts if t and t.split()[0].lower().strip(",.") in ACTION_VERBS)
    joined = "\n".join(texts)
    stuffing = max((len(k.pattern.findall(joined)) for k in kw.lexicon() if kw.keyword_present(k.name, jd)), default=0)
    s, g = result["scores"], result["guardrails"]
    kinds: dict[str, int] = {}
    for f in [x for b in bullets for x in b.get("flags", [])] + r["summary"].get("flags", []):
        k = f.split(":")[0].replace("unverified_", "")
        kinds[k] = kinds.get(k, 0) + 1
    return {
        "flag_types": ", ".join(f"{k}:{v}" for k, v in sorted(kinds.items())) or "-",
        "headline": r["candidate"]["headline"] or "(removed/empty)",
        "valid_first_try": not repaired,
        "match_before": s["match"]["before"]["score"],
        "match_after": s["match"]["after"]["score"],
        "ats_before": s["ats"]["before"]["score"],
        "ats_after": s["ats"]["after"]["score"],
        "skills_stripped": len(g["removed_skills"]),
        "bullets_flagged": g["flagged_bullets"],
        "details_removed": len(g.get("removed_details", [])),
        "bullets": len(bullets),
        "summary_words": len((r["summary"]["tailored"] or "").split()),
        "action_verb_pct": round(100 * verbs / max(1, len(texts))),
        "avg_bullet_words": round(statistics.mean(words), 1),
        "max_keyword_repeats": stuffing,
        "missing_keywords": len(r["missing_keywords"]),
        "seconds": round(result["meta"]["duration_ms"] / 1000, 1),
        "model": f'{result["meta"]["provider"]}:{result["meta"]["model"]}',
    }


async def judge(original: str, tailored: str, jd: str) -> dict:
    messages = [{"role": "system", "content": JUDGE_PROMPT},
                {"role": "user", "content": f"<job>\n{jd}\n</job>\n<original>\n{original}\n</original>\n<tailored>\n{tailored}\n</tailored>"}]
    text, _ = await get_chain().complete(messages, json_mode=True, temperature=0)
    try:
        return pipeline.extract_json(text)
    except ValueError:
        return {"reason": "judge returned invalid JSON"}


async def run(args) -> list[dict]:
    if args.resume:
        p = Path(args.resume)
        resume_text = parse_resume(p.read_bytes(), p.name).text
    else:
        sys.path.insert(0, str(ROOT.parent))
        from tests.fixtures import resume_text as sample
        resume_text = sample()

    jd_files = sorted((ROOT / "jds").glob("*.txt"))
    if args.only:
        jd_files = [f for f in jd_files if args.only in f.stem]

    # Detect whether the first answer needed the JSON-repair round trip.
    repaired_flag = {"value": False}
    original_repair = pipeline._repair_via_llm

    async def tracking_repair(*a, **k):
        repaired_flag["value"] = True
        return await original_repair(*a, **k)

    pipeline._repair_via_llm = tracking_repair

    rows = []
    for f in jd_files:
        jd = f.read_text()
        repaired_flag["value"] = False
        started = time.perf_counter()
        try:
            result = await pipeline.tailor(TailorRequest(job_description=jd, resume_text=resume_text, tone=args.tone))
        except Exception as exc:  # report and continue
            rows.append({"jd": f.stem, "error": f"{type(exc).__name__}: {exc}", "seconds": round(time.perf_counter() - started, 1)})
            print(f"✗ {f.stem}: {exc}")
            continue
        row = {"jd": f.stem, **metrics(result, jd, repaired_flag["value"])}
        if args.judge:
            row["judge"] = await judge(resume_text, result["tailored_text"], jd)
        rows.append(row)
        print(f"✓ {f.stem}: match {row['match_before']}→{row['match_after']}, ATS {row['ats_before']}→{row['ats_after']}, "
              f"stripped {row['skills_stripped']}, flagged {row['bullets_flagged']}, {row['seconds']}s")
    return rows


def write_report(rows: list[dict], path: Path) -> None:
    cols = ["jd", "valid_first_try", "match_before", "match_after", "ats_before", "ats_after", "skills_stripped",
            "bullets_flagged", "flag_types", "details_removed", "summary_words", "action_verb_pct", "avg_bullet_words",
            "max_keyword_repeats", "seconds"]
    lines = ["# Tailoring evaluation", "", f"Model: `{next((r['model'] for r in rows if 'model' in r), 'n/a')}`", "",
             "| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        if "error" in r:
            lines.append(f"| {r['jd']} | error: {r['error']} |" + " |" * (len(cols) - 2))
        else:
            lines.append("| " + " | ".join(str(r.get(c, "")) for c in cols) + " |")
    judged = [r for r in rows if "judge" in r]
    if judged:
        lines += ["", "## LLM-as-judge (1–5)", "", "| jd | truthfulness | relevance | readability | reason |", "|---|---|---|---|---|"]
        for r in judged:
            j = r["judge"]
            lines.append(f"| {r['jd']} | {j.get('truthfulness', '')} | {j.get('relevance', '')} | {j.get('readability', '')} | {j.get('reason', '')} |")
    lines += ["", "Targets: valid_first_try = True · skills_stripped / bullets_flagged / details_removed = 0 · "
              "summary 45–70 words · headline never the JD title · action verbs ≥ 85% · avg bullet ≤ 30 words · max keyword repeats ≤ 3."]
    path.write_text("\n".join(lines) + "\n")
    (path.with_suffix(".json")).write_text(json.dumps(rows, indent=2))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--resume", help="PDF/DOCX resume to use (default: built-in sample)")
    ap.add_argument("--tone", default="balanced", choices=["balanced", "technical", "impact", "leadership", "concise"])
    ap.add_argument("--only", help="run only JDs whose filename contains this text")
    ap.add_argument("--judge", action="store_true", help="also grade outputs with an LLM judge")
    ap.add_argument("--out", default=str(ROOT / "report.md"))
    args = ap.parse_args()
    if not get_chain().providers:
        sys.exit("No LLM provider configured. Set GEMINI_API_KEY / GROQ_API_KEY (or LLM_PROVIDERS=mock) in backend/.env")
    rows = asyncio.run(run(args))
    write_report(rows, Path(args.out))
    print(f"\nReport written to {args.out}")
    if any("error" in r for r in rows):
        sys.exit(1)


if __name__ == "__main__":
    main()
