import json

import pytest

from app.services.llm import factory
from app.services.llm.base import LLMProvider, ProviderError
from app.services.llm.mock import MockProvider
from tests.fixtures import SAMPLE_JD, make_docx, make_pdf, resume_text


def payload(**over):
    return {"job_description": SAMPLE_JD, "resume_text": resume_text(), **over}


def sse_events(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.split("\n\n"):
        lines = [l for l in block.splitlines() if l and not l.startswith(":")]
        ev = next((l[7:] for l in lines if l.startswith("event: ")), None)
        data = next((l[6:] for l in lines if l.startswith("data: ")), None)
        if ev:
            out.append((ev, json.loads(data)))
    return out


# --------------------------------------------------------------------------- #
def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["llm"][0]["provider"] == "mock"


@pytest.mark.parametrize("maker,name,ftype", [(make_pdf, "cv.pdf", "pdf"), (make_docx, "cv.docx", "docx")])
def test_parse_upload(client, maker, name, ftype):
    r = client.post("/api/resume/parse", files={"file": (name, maker(), "application/octet-stream")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["file_type"] == ftype and body["word_count"] > 100 and "Aarav" in body["text"]


def test_parse_errors_are_structured(client):
    r = client.post("/api/resume/parse", files={"file": ("x.png", b"\x89PNG\r\n\x1a\n0000", "image/png")})
    assert r.status_code == 415 and r.json()["error"]["code"] == "unsupported_file"
    r = client.post("/api/resume/parse")
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_input"


def test_score_endpoint(client):
    r = client.post("/api/score", json=payload())
    assert r.status_code == 200
    body = r.json()
    assert body["match"]["before"]["score"] > 0 and "after" not in body["match"]
    assert body["ats"]["before"]["score"] > 0


def test_tailor_end_to_end(client):
    r = client.post("/api/tailor", json=payload())
    assert r.status_code == 200, r.text
    body = r.json()
    res = body["resume"]
    assert res["candidate"]["name"] == "Aarav Sharma"
    assert res["experience"] and res["experience"][0]["bullets"][0]["original"]
    assert body["scores"]["match"]["after"]["score"] is not None
    assert body["scores"]["ats"]["after"]["checks"]
    assert body["meta"]["provider"] == "mock" and body["tailored_text"]
    assert "id" not in body  # anonymous → not saved


def test_tailor_validation_errors(client):
    r = client.post("/api/tailor", json=payload(job_description="short"))
    assert r.status_code == 422 and r.json()["error"]["code"] == "jd_too_short"
    r = client.post("/api/tailor", json=payload(sections=[]))
    assert r.status_code == 422 and "at least one section" in r.json()["error"]["message"]
    r = client.post("/api/tailor", json=payload(tone="angry"))
    assert r.status_code == 422


def test_tailor_stream_emits_status_deltas_and_result(client):
    with client.stream("POST", "/api/tailor/stream", json=payload(sections=["summary", "experience"], tone="impact")) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        text = "".join(r.iter_text())
    events = sse_events(text)
    kinds = [e for e, _ in events]
    assert kinds[0] == "status" and "delta" in kinds and kinds[-1] == "result"
    streamed = "".join(d["text"] for e, d in events if e == "delta")
    assert json.loads(streamed)["candidate"]["name"] == "Aarav Sharma"
    result = events[-1][1]
    assert result["meta"]["sections"] == ["summary", "experience"] and result["meta"]["tone"] == "impact"
    assert result["guardrails"]["locked_sections"] == ["skills", "projects"]


def test_tailor_stream_validation_fails_fast_as_json(client):
    r = client.post("/api/tailor/stream", json=payload(resume_text=""))
    assert r.status_code == 422 and r.json()["error"]["code"] == "resume_empty"


# --------------------------------------------------------------------------- #
class _Flaky(LLMProvider):
    name, model = "flaky", "f"

    def __init__(self, err):
        self.err = err

    async def complete(self, *a, **k):
        raise self.err

    async def stream(self, *a, **k):
        raise self.err
        yield ""  # pragma: no cover


class _BadJSON(MockProvider):
    name = "badjson"

    def __init__(self):
        super().__init__()
        self.calls = 0

    async def complete(self, messages, **k):
        self.calls += 1
        if self.calls == 1:
            return "Sorry, here is part of it: {\"experience\": ["
        return await super().complete(messages, **k)


@pytest.fixture
def chain(monkeypatch):
    def set_providers(*providers):
        monkeypatch.setattr(factory, "get_chain", lambda: factory.ProviderChain(list(providers)))
        import app.services.tailor as t
        import app.api.cover_letter as c
        monkeypatch.setattr(t, "get_chain", lambda: factory.ProviderChain(list(providers)))
        monkeypatch.setattr(c, "get_chain", lambda: factory.ProviderChain(list(providers)))
    return set_providers


def test_falls_back_to_next_provider(client, chain):
    chain(_Flaky(ProviderError("rate limited", retryable=True, status=429)), MockProvider())
    r = client.post("/api/tailor", json=payload())
    assert r.status_code == 200 and r.json()["meta"]["provider"] == "mock"
    with client.stream("POST", "/api/tailor/stream", json=payload()) as s:
        events = sse_events("".join(s.iter_text()))
    assert events[-1][0] == "result"


def test_all_providers_failing_returns_friendly_error(client, chain):
    chain(_Flaky(ProviderError("rate limited", retryable=True, status=429)))
    r = client.post("/api/tailor", json=payload())
    assert r.status_code == 503 and r.json()["error"]["code"] == "llm_rate_limited"
    with client.stream("POST", "/api/tailor/stream", json=payload()) as s:
        events = sse_events("".join(s.iter_text()))
    assert events[-1][0] == "error" and events[-1][1]["code"] == "llm_rate_limited"


def test_no_provider_configured(client, chain):
    chain()
    r = client.post("/api/tailor", json=payload())
    assert r.status_code == 503 and r.json()["error"]["code"] == "llm_not_configured"


def test_invalid_json_is_repaired_with_a_retry(client, chain):
    bad = _BadJSON()
    chain(bad)
    r = client.post("/api/tailor", json=payload())
    assert r.status_code == 200 and bad.calls == 2


def test_not_a_job_description(client, chain):
    class NotJD(MockProvider):
        async def complete(self, messages, **k):
            data = json.loads(await super().complete(messages, **k))
            data["jd_analysis"]["is_job_description"] = False
            return json.dumps(data)
    chain(NotJD())
    r = client.post("/api/tailor", json=payload())
    assert r.status_code == 422 and r.json()["error"]["code"] == "not_a_jd"


# --------------------------------------------------------------------------- #
def test_cover_letter_stream_and_plain(client):
    body = {**payload(), "tone": "enthusiastic", "length": "short", "company": "Acme"}
    with client.stream("POST", "/api/cover-letter/stream", json=body) as r:
        events = sse_events("".join(r.iter_text()))
    assert events[-1][0] == "result" and events[-1][1]["text"].startswith("Dear")
    r = client.post("/api/cover-letter", json=body)
    assert r.status_code == 200 and "Aarav Sharma" in r.json()["text"]


@pytest.mark.parametrize("fmt,magic", [("pdf", b"%PDF"), ("docx", b"PK"), ("txt", b"Aarav"), ("md", b"# Aarav")])
def test_export_resume(client, fmt, magic):
    resume = client.post("/api/tailor", json=payload()).json()["resume"]
    r = client.post("/api/export", json={"format": fmt, "resume": resume})
    assert r.status_code == 200 and r.content.startswith(magic)
    assert f'.{fmt}"' in r.headers["content-disposition"] and "Aarav_Sharma_Resume" in r.headers["content-disposition"]


@pytest.mark.parametrize("fmt,magic", [("pdf", b"%PDF"), ("docx", b"PK"), ("txt", b"Dear")])
def test_export_cover_letter(client, fmt, magic):
    r = client.post("/api/export", json={"format": fmt, "cover_letter": "Dear team,\n\nHello & <welcome>.\n\nBest,\nA", "candidate_name": "Aarav"})
    assert r.status_code == 200 and r.content.startswith(magic)


def test_export_requires_content(client):
    assert client.post("/api/export", json={"format": "pdf"}).status_code == 422


def test_export_unicode_resume(client):
    resume = client.post("/api/tailor", json=payload()).json()["resume"]
    resume["candidate"]["name"] = "Zoë Ångström — 李雷"
    resume["summary"]["tailored"] = "Ships “quality” code → fast & reliable <always>."
    for fmt in ("pdf", "docx"):
        assert client.post("/api/export", json={"format": fmt, "resume": resume}).status_code == 200


# --------------------------------------------------------------------------- #
def test_auth_and_history_flow(client):
    reg = client.post("/api/auth/register", json={"email": "Test@Example.com", "password": "supersecret1", "name": "Tester"})
    assert reg.status_code == 201
    token = reg.json()["token"]
    h = {"Authorization": f"Bearer {token}"}

    assert client.post("/api/auth/register", json={"email": "test@example.com", "password": "supersecret1"}).status_code == 409
    assert client.post("/api/auth/login", json={"email": "test@example.com", "password": "wrongpass1"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "test@example.com", "password": "supersecret1"}).status_code == 200
    assert client.get("/api/auth/me", headers=h).json()["email"] == "test@example.com"
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer junk"}).status_code == 401

    run_id = client.post("/api/tailor", json=payload(resume_filename="cv.pdf"), headers=h).json()["id"]
    with client.stream("POST", "/api/tailor/stream", json=payload(), headers=h) as s:
        streamed_id = sse_events("".join(s.iter_text()))[-1][1]["id"]
    hist = client.get("/api/history", headers=h).json()
    assert {run_id, streamed_id} <= {x["id"] for x in hist}
    assert hist[0]["match_after"] is not None
    assert hist[0]["created_at"].endswith("+00:00")  # timezone-aware, so the UI shows correct "x min ago"

    item = client.get(f"/api/history/{run_id}", headers=h).json()
    assert item["resume_filename"] == "cv.pdf" and item["result"]["resume"]["candidate"]["name"] == "Aarav Sharma"
    assert client.put(f"/api/history/{run_id}/cover-letter", json={"text": "Dear…"}, headers=h).status_code == 200
    assert client.get(f"/api/history/{run_id}", headers=h).json()["result"]["cover_letter"] == "Dear…"

    other = client.post("/api/auth/register", json={"email": "other@example.com", "password": "supersecret1"}).json()["token"]
    assert client.get(f"/api/history/{run_id}", headers={"Authorization": f"Bearer {other}"}).status_code == 404

    assert client.delete(f"/api/history/{run_id}", headers=h).status_code == 204
    assert client.get(f"/api/history/{run_id}", headers=h).status_code == 404


def test_auth_validation(client):
    r = client.post("/api/auth/register", json={"email": "nope", "password": "supersecret1"})
    assert r.status_code == 422 and "valid email" in r.json()["error"]["message"]
    assert client.post("/api/auth/register", json={"email": "a@b.co", "password": "short"}).status_code == 422


def test_rate_limit(client, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "rate_limit_per_minute", 2)
    codes = [client.post("/api/tailor", json=payload()).status_code for _ in range(3)]
    assert codes == [200, 200, 429]
    r = client.post("/api/tailor", json=payload())
    assert r.json()["error"]["code"] == "rate_limited" and int(r.headers["retry-after"]) > 0


def test_cors_headers_present(client):
    r = client.options("/api/tailor", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"
