"""AI chat: proposals (never auto-applied), guardrails on chat edits, layout patches."""

import json

import pytest

from app.services.chat import _merge_layout, _restore_originals
from app.models.schemas import LayoutSettings, TailoredResume
from tests.fixtures import SAMPLE_JD, resume_text


@pytest.fixture
def tailored(client):
    return client.post("/api/tailor", json={"job_description": SAMPLE_JD, "resume_text": resume_text()}).json()["resume"]


def ask(client, resume, message, **extra):
    body = {"message": message, "resume": resume, "job_description": SAMPLE_JD, "resume_text": resume_text(), **extra}
    r = client.post("/api/chat", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_question_gets_reply_without_proposal(client, tailored):
    out = ask(client, tailored, "Is this resume good for the role?")
    assert out["reply"] and out["proposal"] is None


def test_layout_change_is_proposed_not_applied(client, tailored):
    out = ask(client, tailored, "Make the margins 0.5 inch")
    p = out["proposal"]
    assert p["result"] is None and p["layout"]["margins"] == {"top": 0.5, "bottom": 0.5, "left": 0.5, "right": 0.5}


def test_content_edit_returns_scored_guardrailed_result_and_diff(client, tailored):
    out = ask(client, tailored, "Make the bullets shorter")
    p = out["proposal"]
    assert p and p["result"] and p["diff"]
    res = p["result"]
    assert {"resume", "scores", "guardrails", "stats", "tailored_text"} <= set(res)
    assert res["meta"]["source"] == "chat"
    assert all(d["before"] != d["after"] for d in p["diff"])
    # originals untouched
    orig = {b["original"] for e in tailored["experience"] for b in e["bullets"]}
    new_orig = {b["original"] for e in res["resume"]["experience"] for b in e["bullets"]}
    assert new_orig <= orig | {""}


def test_add_summary_turns_on_show_summary(client, tailored):
    out = ask(client, tailored, "Add a short summary")
    p = out["proposal"]
    assert p["layout"]["show_summary"] is True and p["result"]["resume"]["summary"]["tailored"]
    assert p["diff"][0]["path"] == "summary" and "SUMMARY" in p["result"]["tailored_text"]


def test_fabrication_request_is_declined(client, tailored):
    out = ask(client, tailored, "Add 5 years of Kubernetes experience")
    assert out["proposal"] is None and "can't" in out["reply"]


def test_chat_guardrails_strip_invented_skills(client, tailored, monkeypatch):
    from app.services import chat as chat_mod
    from app.services.llm.factory import ProviderChain
    from app.services.llm.mock import MockProvider

    class Liar(MockProvider):
        async def complete(self, messages, **k):
            cur = json.loads(messages[1]["content"].split("<current_resume>\n")[1].split("\n</current_resume>")[0])
            cur["skills"]["groups"][0]["items"].append("Kubernetes")
            cur["experience"][0]["bullets"][0]["tailored"] = "Ran Kubernetes clusters serving 9 million users"
            cur["experience"][0]["bullets"][0]["original"] = "I changed the original too"
            return json.dumps({"reply": "Done", "changes": ["x"], "resume": cur, "layout": None})
    monkeypatch.setattr(chat_mod, "get_chain", lambda: ProviderChain([Liar()]))
    out = ask(client, tailored, "anything")
    res = out["proposal"]["result"]
    assert "Kubernetes" in res["guardrails"]["removed_skills"]
    b = res["resume"]["experience"][0]["bullets"][0]
    assert b["original"] == "" and any(f.startswith("unverified_") for f in b["flags"])


def test_merge_layout_clamps_and_ignores_junk():
    cur = LayoutSettings()
    assert _merge_layout(cur, {"margins": {"left": 9}, "bogus": 1}).margins.left == 1.5
    assert _merge_layout(cur, {"font_size": 99}) is None
    assert _merge_layout(cur, None) is None
    assert _merge_layout(cur, {"font_family": "sans"}) is None  # no actual change


def test_chat_validation(client, tailored):
    body = {"message": "", "resume": tailored, "job_description": SAMPLE_JD, "resume_text": resume_text()}
    assert client.post("/api/chat", json=body).status_code == 422
    body = {"message": "hi", "resume": tailored, "job_description": "short", "resume_text": resume_text()}
    assert client.post("/api/chat", json=body).json()["error"]["code"] == "jd_too_short"
