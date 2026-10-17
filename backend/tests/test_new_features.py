"""Confirmed skills, copied-from-JD detection, JD import from URL, Ollama provider."""

import asyncio

import httpx
import pytest

from app.core.errors import InvalidInputError
from app.models.schemas import TailorRequest
from app.services import jd_fetch
from app.services.tailor import apply_guardrails
from tests.fixtures import SAMPLE_JD, resume_text
from tests.test_tailor import make


def test_confirmed_skill_counts_as_evidence():
    r = make()  # skills include Kubernetes (not in resume)
    req = TailorRequest(job_description=SAMPLE_JD, resume_text=resume_text(),
                        confirmed_skills=[{"keyword": "Kubernetes", "context": "deployed QuickLink on a k3s cluster"}])
    report = apply_guardrails(r, req, resume_text(), [])
    assert "Kubernetes" in r.skills.groups[0].items and "Kubernetes" not in report["removed_skills"]
    assert all(m.keyword != "Kubernetes" for m in r.missing_keywords)
    assert not any(f.startswith("unverified_skill") for f in r.experience[0].bullets[1].flags)
    assert report["confirmed_used"] == ["Kubernetes"]


def test_copied_from_jd_is_flagged():
    r = make()
    jd = SAMPLE_JD + "\nYou will design, build and maintain RESTful APIs and microservices that power payouts."
    r.experience[0].bullets[0].tailored = "Design, build and maintain RESTful APIs and microservices that power payouts for merchants"
    report = apply_guardrails(r, TailorRequest(job_description=jd, resume_text=resume_text()), resume_text(), [], jd)
    assert "copied_from_jd" in r.experience[0].bullets[0].flags and report["copied_from_jd"] == 1


def test_prompt_includes_confirmed_skills():
    from app.services.prompts import build_tailor_messages
    msgs = build_tailor_messages(SAMPLE_JD, resume_text(), ["skills"], "balanced", "",
                                 [{"keyword": "Kafka", "context": "built a consumer in QuickLink"}])
    assert "<candidate_confirmed_skills>" in msgs[1]["content"] and "- Kafka: built a consumer" in msgs[1]["content"]


def test_api_tailor_with_confirmed_skills(client):
    body = {"job_description": SAMPLE_JD, "resume_text": resume_text(), "confirmed_skills": [{"keyword": "Kubernetes"}]}
    res = client.post("/api/tailor", json=body).json()
    items = [i for g in res["resume"]["skills"]["groups"] for i in g["items"]]
    assert "Kubernetes" in items and "Kubernetes" not in res["guardrails"]["removed_skills"]
    assert all(m["keyword"] != "Kubernetes" for m in res["resume"]["missing_keywords"])
    too_many = {**body, "confirmed_skills": [{"keyword": f"s{i}"} for i in range(21)]}
    assert client.post("/api/tailor", json=too_many).status_code == 422


# --------------------------------------------------------------------------- #
JOB_PAGE = """<html><head><title>Backend Engineer | Acme</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme"},
{"@type":"JobPosting","title":"Backend Engineer","hiringOrganization":{"@type":"Organization","name":"Acme Payments"},
"description":"&lt;p&gt;Build RESTful APIs in Python and FastAPI.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Own PostgreSQL schemas and Redis caching for payouts at scale.&lt;/li&gt;&lt;li&gt;Ship with Docker, Kubernetes and CI/CD on AWS, with strong testing and code reviews.&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;We are an equal opportunity employer.&lt;/p&gt;"}]}
</script></head><body><nav>Jobs Home</nav><main>ignored</main></body></html>"""

PLAIN_PAGE = "<html><body><nav>menu menu</nav><main><h1>Data Analyst</h1>" + "<p>Write SQL and build Tableau dashboards for growth reviews every week.</p>" * 8 + "</main><footer>© 2026</footer></body></html>"


def test_extract_job_prefers_structured_data():
    job = jd_fetch.extract_job(JOB_PAGE)
    assert job["source"] == "structured" and job["company"] == "Acme Payments"
    assert job["text"].startswith("Backend Engineer — Acme Payments")
    assert "- Own PostgreSQL schemas" in job["text"] and "<p>" not in job["text"]


def test_extract_job_falls_back_to_main_text():
    job = jd_fetch.extract_job(PLAIN_PAGE)
    assert job["source"] == "page" and "Tableau dashboards" in job["text"] and "menu" not in job["text"] and "©" not in job["text"]


@pytest.mark.parametrize("url", ["http://127.0.0.1/admin", "http://localhost:8000", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data",
                                 "http://[::1]/", "file:///etc/passwd", "ftp://example.com/x", "http://example.com:2375/"])
def test_ssrf_protection(url):
    with pytest.raises(InvalidInputError):
        asyncio.run(jd_fetch.assert_public_url(url))


def _fetch(handler, monkeypatch, url="https://jobs.example.com/123"):
    async def ok(_url):
        return None
    monkeypatch.setattr(jd_fetch, "assert_public_url", ok)
    return asyncio.run(jd_fetch.fetch_job_description(url, transport=httpx.MockTransport(handler)))


def test_fetch_success_with_redirect_and_cleanup(monkeypatch):
    def handler(req):
        if req.url.path == "/123":
            return httpx.Response(302, headers={"location": "/jobs/123"})
        return httpx.Response(200, html=JOB_PAGE)
    out = _fetch(handler, monkeypatch)
    assert out["company"] == "Acme Payments" and out["url"].endswith("/jobs/123")
    assert "equal opportunity" not in out["job_description"] and out["removed_lines"] >= 1


@pytest.mark.parametrize("resp,msg", [
    (httpx.Response(403), "blocked"),
    (httpx.Response(404), "error (404)"),
    (httpx.Response(200, content=b"%PDF-1.4", headers={"content-type": "application/pdf"}), "isn't a web page"),
    (httpx.Response(200, html="<html><body><p>Loading…</p></body></html>"), "JavaScript"),
])
def test_fetch_failures_have_helpful_messages(monkeypatch, resp, msg):
    with pytest.raises(InvalidInputError) as e:
        _fetch(lambda req: resp, monkeypatch)
    assert msg in e.value.message


def test_fetch_detects_login_wall(monkeypatch):
    def handler(req):
        if "authwall" not in str(req.url):
            return httpx.Response(302, headers={"location": "https://www.linkedin.com/authwall?trk=x"})
        return httpx.Response(200, html=PLAIN_PAGE)
    with pytest.raises(InvalidInputError) as e:
        _fetch(handler, monkeypatch, "https://www.linkedin.com/jobs/view/1")
    assert "sign in" in e.value.message


def test_fetch_endpoint_validation(client):
    r = client.post("/api/jd/fetch", json={"url": "http://127.0.0.1:8000/api/health"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "jd_fetch_failed"


def test_ollama_provider_configured(monkeypatch):
    from app.config import get_settings
    from app.services.llm import factory
    monkeypatch.setattr(get_settings(), "llm_providers", "ollama,mock")
    factory.get_chain.cache_clear()
    try:
        chain = factory.get_chain()
        assert [p.name for p in chain.providers] == ["ollama", "mock"]
        assert chain.providers[0].model == "llama3.1"
    finally:
        factory.get_chain.cache_clear()
