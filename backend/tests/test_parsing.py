import pytest

from app.core.errors import FileTooLargeError, ParseError, UnsupportedFileError
from app.services.parsing import detect_sections, normalize_text, parse_resume
from tests.fixtures import RESUME_LINES, make_docx, make_pdf


def test_pdf_extracts_text_links_and_sections():
    r = parse_resume(make_pdf(), "resume.pdf")
    assert r.file_type == "pdf" and r.pages == 1
    assert "Aarav Sharma" in r.text and "Finlytics" in r.text
    assert any("github.com/aarav-dev" in l for l in r.links)
    assert {"experience", "education", "skills", "projects"} <= set(r.sections)
    assert r.word_count > 150


def test_docx_extracts_paragraphs_bullets_tables_and_hyperlinks():
    r = parse_resume(make_docx(), "resume.docx")
    assert r.file_type == "docx"
    assert "• Worked on the payments dashboard" in r.text
    assert "AWS Cloud Practitioner" in r.text  # table content
    assert "https://portfolio.aarav.dev" in r.links


def test_type_detection_ignores_misleading_extension():
    # A real PDF named .docx is still parsed as PDF.
    assert parse_resume(make_pdf(), "resume.docx").file_type == "pdf"


@pytest.mark.parametrize("data,name,exc", [
    (b"", "a.pdf", ParseError),
    (b"\x89PNG\r\n\x1a\n" + b"0" * 100, "photo.png", UnsupportedFileError),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"0" * 100, "old.doc", UnsupportedFileError),
    (b"just some plain text pretending", "resume.txt", UnsupportedFileError),
    (b"%PDF-1.7\n garbage garbage", "broken.pdf", ParseError),
    (b"PK\x03\x04garbage", "broken.docx", ParseError),
])
def test_rejects_bad_files(data, name, exc):
    with pytest.raises(exc):
        parse_resume(data, name)


def test_rejects_large_files(monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "max_upload_mb", 0.001)
    with pytest.raises(FileTooLargeError):
        parse_resume(make_pdf(), "big.pdf")


def test_scanned_pdf_gives_helpful_error():
    with pytest.raises(ParseError) as e:
        parse_resume(make_pdf(blank=True), "scan.pdf")
    assert e.value.code == "no_text" and "scanned" in e.value.message


def test_encrypted_pdf():
    with pytest.raises(ParseError) as e:
        parse_resume(make_pdf(encrypt="secret"), "locked.pdf")
    assert e.value.code == "encrypted"


def test_too_many_pages():
    with pytest.raises(ParseError) as e:
        parse_resume(make_pdf(pages=11), "long.pdf")
    assert e.value.code == "too_many_pages"


def test_too_little_text():
    with pytest.raises(ParseError) as e:
        parse_resume(make_pdf(["Aarav Sharma", "aarav@example.com", "Python developer, React, Node"]), "tiny.pdf")
    assert e.value.code == "too_short"


def test_warns_when_not_resume_like():
    lines = ["Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor"] * 10
    r = parse_resume(make_pdf(lines), "essay.pdf")
    assert any("Is this a resume" in w for w in r.warnings)
    assert any("email" in w for w in r.warnings)


def test_normalize_text():
    raw = "ﬁnancial eﬃcient\n● item one\n item two\n- item three\ndevelop-\nment  (cid:12)x\n\n\n\nend"
    out = normalize_text(raw)
    assert "financial efficient" in out
    assert "• item one" in out and "• item two" in out and "• item three" in out
    assert "development" in out and "(cid" not in out
    assert "\n\n\n" not in out


def test_detect_sections_variants():
    text = "PROFESSIONAL SUMMARY\nx\nWork Experience:\ny\nTechnical Skills\nz\nPositions of Responsibility\nw"
    assert detect_sections(text) == ["summary", "experience", "skills", "positions"]
    assert detect_sections("\n".join(RESUME_LINES))[:2] == ["summary", "experience"]


def test_unmapped_bullet_glyphs_and_wrapped_lines():
    raw = "(cid:127) Built APIs backed by Postgres, cutting latency\nby 35% for checkout.\n(cid:127)(cid:3) Second bullet\nNext Heading"
    out = normalize_text(raw)
    assert out.splitlines() == ["• Built APIs backed by Postgres, cutting latency by 35% for checkout.", "• Second bullet", "Next Heading"]


def test_exported_pdf_round_trips_with_bullets():
    """Our own PDF export must stay ATS-parseable: real bullet characters, all sections."""
    from app.models.schemas import TailoredResume
    from app.services.export import resume_pdf

    r = TailoredResume.model_validate({
        "candidate": {"name": "Aarav Sharma", "contact": {"email": "a@example.com"}},
        "summary": {"tailored": "Backend engineer building reliable APIs with Python and PostgreSQL for fintech products."},
        "skills": {"groups": [{"category": "Languages", "items": ["Python", "SQL"]}]},
        "experience": [{"title": "Intern", "company": "Finlytics", "dates": "2025", "bullets": [{"original": "x", "tailored": "Cut p95 latency by 35% by adding Redis caching to hot endpoints in the payments API."}]}],
        "education": [{"degree": "B.Tech", "institution": "IIT (BHU)"}],
    })
    from app.models.schemas import LayoutSettings
    parsed = parse_resume(resume_pdf(r, LayoutSettings(show_summary=True)), "out.pdf")
    assert "• Cut p95 latency by 35%" in parsed.text
    assert {"summary", "skills", "experience", "education"} <= set(parsed.sections)
