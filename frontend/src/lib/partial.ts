import { ALL, parse } from "partial-json";
import type { TailoredResume } from "./types";

const EMPTY: TailoredResume = {
  jd_analysis: { is_job_description: true, role_title: "", company: "", seniority: "", must_have: [], nice_to_have: [], responsibilities: [] },
  candidate: { name: "", headline: "", contact: { email: "", phone: "", location: "", links: [] } },
  summary: { original: "", tailored: "", rationale: "" },
  skills: { original: [], groups: [], matched: [], rationale: "" },
  experience: [],
  projects: [],
  education: [],
  certifications: [],
  additional_sections: [],
  missing_keywords: [],
  change_log: [],
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function bullets(v: unknown) {
  return (Array.isArray(v) ? v : []).filter(isObj).map((b) => ({
    original: str(b.original),
    tailored: str(b.tailored),
    keywords: strArr(b.keywords),
    flags: [] as string[],
  }));
}

/** Parse an incomplete JSON stream into a renderable (always well-shaped) resume. */
export function parsePartialResume(raw: string): TailoredResume | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let data: unknown;
  try {
    data = parse(raw.slice(start), ALL);
  } catch {
    return null;
  }
  if (!isObj(data)) return null;
  const c = isObj(data.candidate) ? data.candidate : {};
  const contact = isObj(c.contact) ? c.contact : {};
  const summary = isObj(data.summary) ? data.summary : {};
  const skills = isObj(data.skills) ? data.skills : {};
  return {
    ...EMPTY,
    candidate: {
      name: str(c.name),
      headline: str(c.headline),
      contact: {
        email: str(contact.email),
        phone: str(contact.phone),
        location: str(contact.location),
        links: (Array.isArray(contact.links) ? contact.links : []).filter(isObj).map((l) => ({ label: str(l.label), url: str(l.url) })),
      },
    },
    summary: { original: str(summary.original), tailored: str(summary.tailored), rationale: "" },
    skills: {
      ...EMPTY.skills,
      groups: (Array.isArray(skills.groups) ? skills.groups : []).filter(isObj).map((g) => ({ category: str(g.category), items: strArr(g.items) })),
    },
    experience: (Array.isArray(data.experience) ? data.experience : []).filter(isObj).map((e) => ({
      title: str(e.title), company: str(e.company), location: str(e.location), dates: str(e.dates), bullets: bullets(e.bullets), rationale: "",
    })),
    projects: (Array.isArray(data.projects) ? data.projects : []).filter(isObj).map((p) => ({
      name: str(p.name), tech: strArr(p.tech), dates: str(p.dates), link: str(p.link), bullets: bullets(p.bullets), rationale: "",
    })),
    education: (Array.isArray(data.education) ? data.education : []).filter(isObj).map((e) => ({
      degree: str(e.degree), institution: str(e.institution), location: str(e.location), dates: str(e.dates), details: strArr(e.details),
    })),
    certifications: strArr(data.certifications),
    additional_sections: (Array.isArray(data.additional_sections) ? data.additional_sections : []).filter(isObj).map((s) => ({ title: str(s.title), items: strArr(s.items) })),
  };
}
