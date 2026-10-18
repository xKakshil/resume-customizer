// Mirrors backend/app/models/schemas.py

export type Section = "summary" | "skills" | "experience" | "projects";
export type Tone = "balanced" | "technical" | "impact" | "leadership" | "concise";
export const ALL_SECTIONS: Section[] = ["summary", "skills", "experience", "projects"];
/** Summary is opt-in: most recruiters skim past it and it is where AI filler creeps in. */
export const DEFAULT_SECTIONS: Section[] = ["skills", "experience", "projects"];

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
  summary: { original: string; tailored: string; rationale: string; flags?: string[] };
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
  optional_total?: number;
  optional_matched?: number;
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
  /** Matched keyword → sections of the tailored resume that contain it. */
  locations?: Record<string, string[]>;
}

export interface EditStats {
  kept: number;
  light: number;
  rewritten: number;
  new: number;
  total: number;
}

export interface TailorResult {
  id?: number;
  resume: TailoredResume;
  tailored_text: string;
  scores: Scores;
  stats?: EditStats;
  guardrails: {
    removed_skills: string[];
    flagged_bullets: number;
    locked_sections: Section[];
    removed_details?: string[];
    copied_from_jd?: number;
    confirmed_used?: string[];
    supporting_used?: boolean;
    summary_flagged?: string[];
  };
  meta: { provider: string; model: string; tone: Tone; sections: Section[]; duration_ms: number; created_at: string; source?: "tailor" | "chat" };
  cover_letter?: string;
}

export interface ParsedResume {
  text: string;
  filename: string;
  file_type: "pdf" | "docx" | "tex";
  size_bytes: number;
  pages: number | null;
  word_count: number;
  char_count: number;
  links: string[];
  sections: string[];
  warnings: string[];
  layout?: LayoutCheck[];
  /** Visual style detected from the uploaded file (used by the "Match original" template). */
  style?: DetectedStyle;
  /** Server-side handle to the original file (kept 48 h) so DOCX/LaTeX can be edited in place. */
  source_id?: string;
}

export interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type TemplateId = "original" | "classic" | "compact" | "modern";

/** Mirrors LayoutSettings: page setup + visual style for previews and downloads. */
export interface LayoutSettings {
  template: TemplateId;
  page_size: "A4" | "Letter";
  margins: Margins;
  font_family: "sans" | "serif";
  font_size: number;
  name_size: number;
  heading_size: number;
  line_spacing: number;
  heading_case: "upper" | "title" | "smallcaps";
  heading_rule: boolean;
  header_align: "center" | "left";
  accent: string;
  show_summary: boolean;
  one_page: boolean;
}

export interface DetectedStyle extends Partial<Omit<LayoutSettings, "template" | "show_summary" | "one_page">> {
  detected?: boolean;
  source?: "pdf" | "docx" | "tex";
  font_name?: string;
}

/** Optional extra material — secondary evidence, never the primary resume. */
export interface SupportingDoc {
  id: string;
  label: string;
  text: string;
  filename?: string;
  word_count: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatDiff {
  path: string;
  label: string;
  before: string;
  after: string;
}

export interface ChatProposal {
  result: TailorResult | null;
  layout: LayoutSettings | null;
  diff: ChatDiff[];
}

export interface ChatResponse {
  reply: string;
  changes: string[];
  proposal: ChatProposal | null;
  provider: string;
  model: string;
}

/** One message in the chat panel, with its proposal and what happened to it. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  changes?: string[];
  proposal?: ChatProposal | null;
  /** Page setup when the proposal was made, so its layout changes can still be described after applying. */
  baseLayout?: LayoutSettings;
  status?: "pending" | "applied" | "discarded";
  error?: boolean;
}

export interface LayoutCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  tip: string | null;
}

export interface ExportCheck {
  pages: number;
  sections_expected: string[];
  sections_found: string[];
  bullets_total: number;
  bullets_found: number;
  contact_found: boolean;
  layout: LayoutCheck[];
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

/** A skill the user confirmed they have although the resume doesn't show it. */
export interface ConfirmedSkill {
  keyword: string;
  context: string;
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
