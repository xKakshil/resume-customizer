// Mirrors backend/app/models/schemas.py

export type Section = "summary" | "skills" | "experience" | "projects";
export type Tone = "balanced" | "technical" | "impact" | "leadership" | "concise";
export const ALL_SECTIONS: Section[] = ["summary", "skills", "experience", "projects"];

export interface Bullet {
  original: string;
  tailored: string;
  keywords: string[];
  flags: string[];
}

export interface TailoredResume {
  jd_analysis: {
    is_job_description: boolean;
    role_title: string;
    company: string;
    seniority: string;
    must_have: string[];
    nice_to_have: string[];
    responsibilities: string[];
  };
  candidate: {
    name: string;
    headline: string;
    contact: { email: string; phone: string; location: string; links: { label: string; url: string }[] };
  };
  summary: { original: string; tailored: string; rationale: string };
  skills: { original: string[]; groups: { category: string; items: string[] }[]; matched: string[]; rationale: string };
  experience: { title: string; company: string; location: string; dates: string; bullets: Bullet[]; rationale: string }[];
  projects: { name: string; tech: string[]; dates: string; link: string; bullets: Bullet[]; rationale: string }[];
  education: { degree: string; institution: string; location: string; dates: string; details: string[] }[];
  certifications: string[];
  additional_sections: { title: string; items: string[] }[];
  missing_keywords: { keyword: string; importance: "high" | "medium" | "low"; suggestion: string }[];
  change_log: string[];
}

export interface KeywordHit {
  keyword: string;
  category: string;
  weight: number;
  required: boolean;
  jd_count: number;
}

export interface MatchResult {
  score: number | null;
  matched: KeywordHit[];
  missing: KeywordHit[];
  total: number;
  required_total: number;
  required_matched: number;
  note?: string;
}

export interface AtsCheck {
  id: string;
  label: string;
  score: number;
  max: number;
  status: "pass" | "warn" | "fail";
  detail: string;
  tip: string | null;
}

export interface AtsResult {
  score: number;
  grade: string;
  checks: AtsCheck[];
}

export interface Scores {
  match: { before: MatchResult; after?: MatchResult };
  ats: { before: AtsResult; after?: AtsResult };
  /** Matched JD keywords demonstrated in a bullet vs only listed in Skills. */
  evidence?: { shown: string[]; listed_only: string[] };
}

export interface TailorResult {
  id?: number;
  resume: TailoredResume;
  tailored_text: string;
  scores: Scores;
  guardrails: { removed_skills: string[]; flagged_bullets: number; locked_sections: Section[]; removed_details?: string[] };
  meta: { provider: string; model: string; tone: Tone; sections: Section[]; duration_ms: number; created_at: string };
  cover_letter?: string;
}

export interface ParsedResume {
  text: string;
  filename: string;
  file_type: "pdf" | "docx";
  size_bytes: number;
  pages: number | null;
  word_count: number;
  char_count: number;
  links: string[];
  sections: string[];
  warnings: string[];
}

export interface User {
  id: number;
  email: string;
  name: string;
}

export interface HistoryItem {
  id: number;
  title: string;
  company: string;
  resume_filename: string;
  match_before: number | null;
  match_after: number | null;
  tone: Tone | null;
  created_at: string;
}

/** A generated version kept on the client so users can compare and refine. */
export interface Version {
  key: string;
  label: string;
  result: TailorResult;
  /** Bullet/summary decisions: path → true means "keep original". */
  rejected: Record<string, boolean>;
  /** Manual edits: path → text. */
  edits: Record<string, string>;
}
