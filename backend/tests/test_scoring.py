from app.services.keywords import extract_jd_keywords, keyword_present, match_score, resume_skills
from app.services.scoring import ats_score
from tests.fixtures import SAMPLE_JD, resume_text


def names(jd):
    return {k.name for k in extract_jd_keywords(jd)}


def test_extracts_and_weights_jd_keywords():
    kws = extract_jd_keywords(SAMPLE_JD)
    n = {k.name for k in kws}
    assert {"Python", "FastAPI", "PostgreSQL", "Redis", "Docker", "CI/CD", "GitHub Actions", "Kubernetes", "Kafka", "SOC2"} <= n
    by = {k.name: k for k in kws}
    assert by["PostgreSQL"].required and not by["Kafka"].required
    assert by["PostgreSQL"].weight > by["Kafka"].weight


def test_aliases_match_both_ways():
    assert keyword_present("PostgreSQL", "Built APIs on Postgres")
    assert keyword_present("Kubernetes", "deployed to k8s")
    assert keyword_present("Node.js", "Node and Express")
    assert keyword_present("REST API", "designed RESTful services")


def test_no_false_positives_from_english_words():
    jd = "You will go above and beyond, take some rest, and excel at communication with the rest of the team. " * 3
    n = names(jd)
    assert "Go" not in n and "REST API" not in n and "Excel" not in n
    assert "C" not in resume_skills("Experience with C++ and C# only")
    assert "c++" in resume_skills("Experience with C++") and "c#" in resume_skills("C# developer")


def test_match_score_and_explanations():
    res = match_score(extract_jd_keywords(SAMPLE_JD), resume_text())
    assert 30 < res["score"] < 95
    matched = {m["keyword"] for m in res["matched"]}
    missing = {m["keyword"] for m in res["missing"]}
    assert {"PostgreSQL", "Redis", "Docker"} <= matched
    assert {"Kubernetes", "AWS", "Kafka"} <= missing


def test_match_score_handles_jd_without_skills():
    res = match_score(extract_jd_keywords("We want a nice person to join our friendly group of people. " * 5), "anything")
    assert res["score"] is None


def test_ats_score_breakdown():
    res = ats_score(resume_text(), 70)
    assert 0 <= res["score"] <= 100 and res["grade"]
    ids = {c["id"] for c in res["checks"]}
    assert ids == {"contact", "sections", "keywords", "action_verbs", "quantified", "bullet_length", "length", "style", "parseability"}
    av = next(c for c in res["checks"] if c["id"] == "action_verbs")
    assert "weak phrases" in av["detail"]  # "Worked on", "Responsible for", "Helped"


def test_ats_score_penalises_poor_resume():
    poor = "John\nI am a hardworking team player. I did many things at my job and I like computers."
    assert ats_score(poor, 10)["score"] < 30
