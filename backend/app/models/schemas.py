"""Request/response models. The tailored resume keeps both the *original* and
*tailored* text for every rewritable unit (summary, each bullet), which is what
powers the per-bullet diff view and the "why this changed" explanations."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

Section = Literal["summary", "skills", "experience", "projects"]
Tone = Literal["balanced", "technical", "impact", "leadership", "concise"]
ALL_SECTIONS: tuple[Section, ...] = ("summary", "skills", "experience", "projects")


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


class TailorRequest(BaseModel):
    job_description: str
    resume_text: str
    sections: list[Section] = Field(default_factory=lambda: list(ALL_SECTIONS))
    tone: Tone = "balanced"
    extra_instructions: str = Field(default="", max_length=500)
    resume_filename: str = ""
    confirmed_skills: list[ConfirmedSkill] = Field(default_factory=list, max_length=20)

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


class ExportRequest(BaseModel):
    format: Literal["pdf", "docx", "txt", "md", "tex"]
    resume: TailoredResume | None = None
    cover_letter: str | None = None
    candidate_name: str = ""
    filename: str = Field(default="", max_length=120)


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


# ----------------------------------------------------------------------------- #
# Interview preparation
# ----------------------------------------------------------------------------- #
class InterviewQuestion(Lenient):
    category: Literal["behavioral", "technical", "project", "role"] = "technical"
    question: str = ""
    why_they_ask: str = ""
    answer_points: list[str] = Field(default_factory=list)
    based_on: str = ""  # which resume item backs the answer

    @field_validator("category", mode="before")
    @classmethod
    def _norm_category(cls, v):
        v = str(v or "technical").lower().strip()
        return v if v in {"behavioral", "technical", "project", "role"} else "technical"


class PrepGap(Lenient):
    skill: str = ""
    why_it_matters: str = ""
    how_to_prepare: str = ""


class InterviewPrep(Lenient):
    role_fit: list[str] = Field(default_factory=list)
    questions: list[InterviewQuestion] = Field(default_factory=list)
    skill_gaps: list[PrepGap] = Field(default_factory=list)
    questions_to_ask: list[str] = Field(default_factory=list)


class InterviewPrepRequest(BaseModel):
    job_description: str
    resume_text: str
    count: int = Field(default=10, ge=4, le=16)
