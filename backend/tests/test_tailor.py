import json

import pytest

from app.core.errors import InvalidInputError, LLMError
from app.models.schemas import TailoredResume, TailorRequest
from app.services import keywords as kw
from app.services.tailor import apply_guardrails, extract_json, parse_tailored, validate_inputs
from tests.fixtures import SAMPLE_JD, resume_text


def make(**over) -> TailoredResume:
    base = {
        "jd_analysis": {"is_job_description": True, "role_title": "Backend Engineer"},
        "candidate": {"name": "Aarav Sharma"},
        "summary": {"original": "Software engineer with experience building web applications and APIs.", "tailored": "Backend engineer…"},
        "skills": {"original": ["Python", "Postgres"], "groups": [{"category": "Languages", "items": ["Python", "Kubernetes", "PostgreSQL", "Payments domain"]}],
                   "matched": ["Python", "Kubernetes"]},
        "experience": [{"title": "SWE Intern", "company": "Finlytics", "bullets": [
            {"original": "Wrote unit tests with Jest and set up GitHub Actions CI for the frontend repo.", "tailored": "Raised test coverage to 90% with Jest"},
            {"original": "Worked on the payments dashboard using React and TypeScript used by 12,000 merchants.", "tailored": "Built a payments dashboard in React for 12,000 merchants, deployed on Kubernetes"},
        ]}],
        "missing_keywords": [{"keyword": "Redis", "importance": "high"}, {"keyword": "Kafka", "importance": "LOW"}, {"keyword": "kafka"}],
    }
    base.update(over)
    return TailoredResume.model_validate(base)


def req(**over) -> TailorRequest:
    return TailorRequest(job_description=SAMPLE_JD, resume_text=resume_text(), **over)


def test_guardrail_removes_unevidenced_skills_and_moves_them_to_missing():
    r = make()
    report = apply_guardrails(r, req(), resume_text(), kw.extract_jd_keywords(SAMPLE_JD))
    items = r.skills.groups[0].items
    assert "Python" in items and "PostgreSQL" in items  # Postgres in resume → PostgreSQL is evidenced
    assert "Kubernetes" not in items and "Payments domain" not in items
    assert "Kubernetes" in report["removed_skills"]
    assert "Kubernetes" not in r.skills.matched
    missing = [m.keyword for m in r.missing_keywords]
    assert "Kubernetes" in missing
    assert "Redis" not in missing  # resume has Redis → not "missing"
    assert [m.keyword.lower() for m in r.missing_keywords].count("kafka") == 1


def test_guardrail_flags_new_numbers_and_tech():
    r = make()
    report = apply_guardrails(r, req(), resume_text(), [])
    b0, b1 = r.experience[0].bullets
    assert any(f.startswith("unverified_number:") and "90" in f for f in b0.flags)
    assert any(f.startswith("unverified_skill:") and "kubernetes" in f for f in b1.flags)
    assert not any("12,000" in f for f in b1.flags)
    assert report["flagged_bullets"] == 2


def test_locked_sections_are_restored_verbatim_and_in_order():
    r = make()
    apply_guardrails(r, req(sections=["skills"]), resume_text(), [])
    assert r.summary.tailored == r.summary.original
    bullets = r.experience[0].bullets
    assert all(b.tailored == b.original and not b.flags for b in bullets)
    # Original resume order: "Worked on…" comes before "Wrote unit tests…"
    assert bullets[0].original.startswith("Worked on")


def test_extract_json_tolerates_fences_prose_and_trailing_commas():
    assert extract_json('```json\n{"a": 1,}\n```') == {"a": 1}
    assert extract_json('Sure! Here it is:\n{"a": [1, 2,], "b": "x"}\nThanks') == {"a": [1, 2], "b": "x"}
    with pytest.raises(ValueError):
        extract_json("no json here")


def test_parse_tailored_coerces_nulls_and_bad_enums():
    r = parse_tailored(json.dumps({"summary": None, "experience": [{"title": "X", "bullets": None}],
                                   "missing_keywords": [{"keyword": "Go", "importance": "critical"}]}))
    assert r.summary.tailored == "" and r.experience[0].bullets == []
    assert r.missing_keywords[0].importance == "medium"
    with pytest.raises(LLMError):
        parse_tailored('{"experience": "oops"')


@pytest.mark.parametrize("jd,code", [("", "jd_empty"), ("too short", "jd_too_short"), ("word " * 60, "not_a_jd")])
def test_validate_inputs_jd(jd, code):
    with pytest.raises(InvalidInputError) as e:
        validate_inputs(jd, resume_text())
    assert e.value.code == code


def test_validate_inputs_resume():
    with pytest.raises(InvalidInputError):
        validate_inputs(SAMPLE_JD, "")
    with pytest.raises(InvalidInputError):
        validate_inputs("x" * 25_000, resume_text())


def test_request_requires_a_section():
    with pytest.raises(ValueError):
        TailorRequest(job_description=SAMPLE_JD, resume_text=resume_text(), sections=[])


def test_guardrail_removes_invented_dates_and_locations():
    r = make()
    r.experience[0].dates = "Jan 2019 – Dec 2021"  # resume says 2025
    r.experience[0].location = "San Francisco"
    report = apply_guardrails(r, req(), resume_text(), [])
    assert r.experience[0].dates == "" and r.experience[0].location == ""
    assert len(report["removed_details"]) == 2


def test_guardrail_keeps_real_dates_and_locations():
    r = make()
    r.experience[0].dates = "Jan 2025 – Jun 2025"
    r.experience[0].location = "Bengaluru"
    report = apply_guardrails(r, req(), resume_text(), [])
    assert r.experience[0].dates == "Jan 2025 – Jun 2025" and r.experience[0].location == "Bengaluru"
    assert report["removed_details"] == []


def test_skill_evidence_split():
    from app.services.tailor import skill_evidence

    r = make()
    match = {"matched": [{"keyword": "React"}, {"keyword": "Python"}]}
    ev = skill_evidence(r, match)
    assert ev == {"shown": ["React"], "listed_only": ["Python"]}


def test_clean_jd_removes_board_boilerplate_only():
    from app.services.jd import clean_jd

    raw = ("Backend Engineer\nBackend Engineer\nPosted 3 days ago\n120 applicants\nApply now\n\n"
           "Build REST APIs in Python.\nWe are an equal opportunity employer and value diversity.\n"
           "Job ID: 12345\nShow more\nYou will own services end to end.")
    out, removed = clean_jd(raw)
    assert removed == 7
    assert out.splitlines()[0] == "Backend Engineer"
    assert "Build REST APIs in Python." in out and "own services" in out
    assert "Apply now" not in out and "equal opportunity" not in out


def test_headline_copying_jd_title_is_removed():
    r = make()
    r.jd_analysis.role_title = "Machine Learning Engineer Intern"
    r.candidate.headline = "Machine Learning Engineer Intern"
    report = apply_guardrails(r, req(), resume_text(), [])
    assert r.candidate.headline == "" and any("headline" in d for d in report["removed_details"])


def test_honest_headline_is_kept():
    r = make()
    r.candidate.headline = "Software Engineer · Python & React"
    apply_guardrails(r, req(), resume_text(), [])
    assert r.candidate.headline == "Software Engineer · Python & React"


def test_summary_with_unverified_skill_is_flagged():
    r = make()
    r.summary.tailored = "Backend engineer running Kubernetes clusters in production for payments."
    apply_guardrails(r, req(), resume_text(), [])
    assert any(f.startswith("unverified_skill") and "kubernetes" in f for f in r.summary.flags)
