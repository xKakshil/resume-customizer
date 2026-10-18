"""Request/response models. The tailored resume keeps both the *original* and
*tailored* text for every rewritable unit (summary, each bullet), which is what
powers the per-bullet diff view and the "why this changed" explanations."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

Section = Literal["summary", "skills", "experience", "projects"]
Tone = Literal["balanced", "technical", "impact", "leadership", "concise"]
ALL_SECTIONS: tuple[Section, ...] = ("summary", "skills", "experience", "projects")
# A summary is opt-in: many recruiters skip them, and an invented one is the easiest
# place for a model to over-claim. Users add one explicitly.
DEFAULT_SECTIONS: tuple[Section, ...] = ("skills", "experience", "projects")


# ----------------------------------------------------------------------------- #
# Tailored resume structure (what the LLM returns, after validation/guardrails)
# ----------------------------------------------------------------------------- #
class Lenient(BaseModel):
    """LLMs occasionally return null for lists/strings; coerce instead of failing."""

    model_config = {"extra": "ignore"}

    @field_validator("*", mode="before")
    @classmethod
    def _none_to_default(cls, v, info):
        if v is None:
            field = cls.model_fields.get(info.field_name)
            if field is not None and not field.is_required():
                return field.get_default(call_default_factory=True)
        return v


class Link(Lenient):
    label: str = ""
    url: str = ""


class Contact(Lenient):
    email: str = ""
    phone: str = ""
    location: str = ""
    links: list[Link] = Field(default_factory=list)


class Candidate(Lenient):
    name: str = ""
    headline: str = ""
    contact: Contact = Field(default_factory=Contact)


class JDAnalysis(Lenient):
    is_job_description: bool = True
    role_title: str = ""
    company: str = ""
    seniority: str = ""
    must_have: list[str] = Field(default_factory=list)
    nice_to_have: list[str] = Field(default_factory=list)
    responsibilities: list[str] = Field(default_factory=list)


class Summary(Lenient):
    original: str = ""
    tailored: str = ""
    rationale: str = ""
    flags: list[str] = Field(default_factory=list)  # set by guardrails


class SkillGroup(Lenient):
    category: str = ""
    items: list[str] = Field(default_factory=list)


class Skills(Lenient):
    original: list[str] = Field(default_factory=list)
    groups: list[SkillGroup] = Field(default_factory=list)
    matched: list[str] = Field(default_factory=list)
    rationale: str = ""


class Bullet(Lenient):
    original: str = ""
    tailored: str = ""
    keywords: list[str] = Field(default_factory=list)
    flags: list[str] = Field(default_factory=list)  # set by guardrails, e.g. "new_metric"


class ExperienceItem(Lenient):
    title: str = ""
    company: str = ""
    location: str = ""
    dates: str = ""
    bullets: list[Bullet] = Field(default_factory=list)
    rationale: str = ""


class ProjectItem(Lenient):
    name: str = ""
    tech: list[str] = Field(default_factory=list)
    dates: str = ""
    link: str = ""
    bullets: list[Bullet] = Field(default_factory=list)
    rationale: str = ""


class EducationItem(Lenient):
    degree: str = ""
    institution: str = ""
    location: str = ""
    dates: str = ""
    details: list[str] = Field(default_factory=list)


class ExtraSection(Lenient):
    title: str = ""
    items: list[str] = Field(default_factory=list)


class MissingKeyword(Lenient):
    keyword: str = ""
    importance: Literal["high", "medium", "low"] = "medium"
    suggestion: str = ""

    @field_validator("importance", mode="before")
    @classmethod
    def _norm_importance(cls, v):
        v = str(v or "medium").lower().strip()
        return v if v in {"high", "medium", "low"} else "medium"


class TailoredResume(Lenient):
    jd_analysis: JDAnalysis = Field(default_factory=JDAnalysis)
    candidate: Candidate = Field(default_factory=Candidate)
    summary: Summary = Field(default_factory=Summary)
    skills: Skills = Field(default_factory=Skills)
    experience: list[ExperienceItem] = Field(default_factory=list)
    projects: list[ProjectItem] = Field(default_factory=list)
    education: list[EducationItem] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    additional_sections: list[ExtraSection] = Field(default_factory=list)
    missing_keywords: list[MissingKeyword] = Field(default_factory=list)
    change_log: list[str] = Field(default_factory=list)


# ----------------------------------------------------------------------------- #
# API requests
# ----------------------------------------------------------------------------- #
class ConfirmedSkill(BaseModel):
    """A skill the user confirmed they have even though the resume doesn't show it."""

    keyword: str = Field(min_length=1, max_length=60)
    context: str = Field(default="", max_length=300)


class SupportingDocument(BaseModel):
    """Optional extra material (another resume, project write-ups, role details).
    Secondary evidence only: it can enrich existing entries and the summary but
    never becomes the primary resume."""

    label: str = Field(default="Supporting document", max_length=80)
    text: str = Field(min_length=1, max_length=20_000)


class TailorRequest(BaseModel):
    job_description: str
    resume_text: str
    sections: list[Section] = Field(default_factory=lambda: list(DEFAULT_SECTIONS))
    tone: Tone = "balanced"
    extra_instructions: str = Field(default="", max_length=500)
    resume_filename: str = ""
    confirmed_skills: list[ConfirmedSkill] = Field(default_factory=list, max_length=20)
    supporting_documents: list[SupportingDocument] = Field(default_factory=list, max_length=5)

    @property
    def include_summary(self) -> bool:
        return "summary" in self.sections

    @field_validator("sections")
    @classmethod
    def _sections(cls, v: list[str]) -> list[str]:
        v = list(dict.fromkeys(v))
        if not v:
            raise ValueError("Select at least one section to customise.")
        return v


class CoverLetterRequest(BaseModel):
    job_description: str
    resume_text: str
    tone: Literal["professional", "enthusiastic", "concise", "storytelling"] = "professional"
    length: Literal["short", "medium", "long"] = "medium"
    hiring_manager: str = Field(default="", max_length=100)
    company: str = Field(default="", max_length=100)


class ScoreRequest(BaseModel):
    job_description: str
    resume_text: str


class Margins(BaseModel):
    top: float = Field(default=0.6, ge=0.2, le=2.0)
    bottom: float = Field(default=0.6, ge=0.2, le=2.0)
    left: float = Field(default=0.65, ge=0.2, le=2.0)
    right: float = Field(default=0.65, ge=0.2, le=2.0)


class LayoutSettings(BaseModel):
    """Page setup + visual style. Templates are presets of these values; "original"
    means: values detected from the uploaded file, and for DOCX/LaTeX uploads the
    original file itself is edited so its exact design is kept."""

    template: Literal["original", "classic", "compact", "modern"] = "classic"
    page_size: Literal["A4", "Letter"] = "A4"
    margins: Margins = Field(default_factory=Margins)  # inches
    font_family: Literal["sans", "serif"] = "sans"
    font_size: float = Field(default=10.0, ge=8.0, le=13.0)  # body text, pt
    name_size: float = Field(default=19.0, ge=12.0, le=32.0)
    heading_size: float = Field(default=11.0, ge=8.0, le=18.0)
    line_spacing: float = Field(default=1.25, ge=1.0, le=1.8)
    heading_case: Literal["upper", "title", "smallcaps"] = "upper"
    heading_rule: bool = True
    header_align: Literal["center", "left"] = "center"
    accent: str = Field(default="#21335a", pattern=r"^#[0-9a-fA-F]{6}$")
    show_summary: bool = False
    one_page: bool = True


class ExportRequest(BaseModel):
    format: Literal["pdf", "docx", "txt", "md", "tex"]
    resume: TailoredResume | None = None
    cover_letter: str | None = None
    candidate_name: str = ""
    filename: str = Field(default="", max_length=120)
    layout: LayoutSettings = Field(default_factory=LayoutSettings)
    source_id: str = Field(default="", max_length=64)  # uploaded original, for template "original"
    inline: bool = False  # serve for in-browser preview instead of download


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1500)
    history: list[ChatTurn] = Field(default_factory=list, max_length=12)
    resume: TailoredResume
    job_description: str
    resume_text: str
    layout: LayoutSettings = Field(default_factory=LayoutSettings)
    sections: list[Section] = Field(default_factory=lambda: list(DEFAULT_SECTIONS))
    confirmed_skills: list[ConfirmedSkill] = Field(default_factory=list, max_length=20)
    supporting_documents: list[SupportingDocument] = Field(default_factory=list, max_length=5)


class AuthRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(default="", max_length=100)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        import re

        v = v.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", v):
            raise ValueError("Enter a valid email address.")
        return v
