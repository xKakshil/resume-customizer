import type { DetectedStyle, LayoutSettings, ParsedResume, TemplateId } from "./types";

export const DEFAULT_LAYOUT: LayoutSettings = {
  template: "classic",
  page_size: "A4",
  margins: { top: 0.6, bottom: 0.6, left: 0.65, right: 0.65 },
  font_family: "sans",
  font_size: 10,
  name_size: 19,
  heading_size: 11,
  line_spacing: 1.25,
  heading_case: "upper",
  heading_rule: true,
  header_align: "center",
  accent: "#21335a",
  show_summary: false,
  one_page: true,
};

type Style = Omit<LayoutSettings, "template" | "page_size" | "show_summary" | "one_page">;

/** Built-in looks. Page size, summary and one-page stay as the user set them. */
export const PRESETS: Record<Exclude<TemplateId, "original">, { label: string; hint: string; style: Style }> = {
  classic: {
    label: "Classic",
    hint: "Centred header, ruled headings",
    style: { margins: { top: 0.6, bottom: 0.6, left: 0.65, right: 0.65 }, font_family: "sans", font_size: 10, name_size: 19, heading_size: 11, line_spacing: 1.25, heading_case: "upper", heading_rule: true, header_align: "center", accent: "#21335a" },
  },
  compact: {
    label: "Compact",
    hint: "Tighter, fits more on one page",
    style: { margins: { top: 0.45, bottom: 0.45, left: 0.5, right: 0.5 }, font_family: "sans", font_size: 9.5, name_size: 16, heading_size: 10, line_spacing: 1.1, heading_case: "upper", heading_rule: true, header_align: "left", accent: "#16233b" },
  },
  modern: {
    label: "Serif",
    hint: "Traditional serif, small caps",
    style: { margins: { top: 0.7, bottom: 0.7, left: 0.75, right: 0.75 }, font_family: "serif", font_size: 10.5, name_size: 22, heading_size: 11.5, line_spacing: 1.3, heading_case: "smallcaps", heading_rule: true, header_align: "center", accent: "#1d37ad" },
  },
};

const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;

/** Settings that reproduce the uploaded file's look (from the server's style detection). */
export function fromStyle(st: DetectedStyle | undefined, base: LayoutSettings): LayoutSettings {
  if (!st) return { ...base, template: "original" };
  const m = st.margins ?? base.margins;
  return {
    ...base,
    template: "original",
    page_size: st.page_size ?? base.page_size,
    margins: { top: clamp(m.top, 0.2, 2), bottom: clamp(m.bottom, 0.2, 2), left: clamp(m.left, 0.2, 2), right: clamp(m.right, 0.2, 2) },
    font_family: st.font_family ?? base.font_family,
    font_size: clamp(st.font_size ?? base.font_size, 8, 13),
    name_size: clamp(st.name_size ?? base.name_size, 12, 32),
    heading_size: clamp(st.heading_size ?? base.heading_size, 8, 18),
    line_spacing: clamp(st.line_spacing ?? base.line_spacing, 1, 1.8),
    heading_case: st.heading_case ?? base.heading_case,
    heading_rule: st.heading_rule ?? base.heading_rule,
    header_align: st.header_align ?? base.header_align,
    accent: st.accent && /^#[0-9a-f]{6}$/i.test(st.accent) ? st.accent : base.accent,
  };
}

export function applyTemplate(t: TemplateId, cur: LayoutSettings, parsed: ParsedResume | null): LayoutSettings {
  if (t === "original") return fromStyle(parsed?.style, cur);
  return { ...cur, ...PRESETS[t].style, margins: { ...PRESETS[t].style.margins }, template: t };
}

/** What "Match original" can promise for this upload. */
export function originalMode(parsed: ParsedResume | null): { available: boolean; exact: string; hint: string } {
  if (!parsed) return { available: false, exact: "", hint: "Upload a resume first." };
  if (parsed.file_type === "docx") return { available: true, exact: "Word", hint: "Word download edits your own file — exact design kept. Preview is a close match." };
  if (parsed.file_type === "tex") return { available: true, exact: "LaTeX", hint: "Your .tex file is edited in place, so the exact template is kept." };
  return { available: !!parsed.style?.detected, exact: "", hint: "Fonts, sizes, margins and heading style are detected from your PDF and recreated." };
}

/** Migrate whatever was saved before (older versions had no layout). */
export function normalizeLayout(saved: Partial<LayoutSettings> | null | undefined): LayoutSettings {
  if (!saved) return DEFAULT_LAYOUT;
  return { ...DEFAULT_LAYOUT, ...saved, margins: { ...DEFAULT_LAYOUT.margins, ...(saved.margins ?? {}) } };
}
