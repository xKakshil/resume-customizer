import type { Bullet, TailoredResume, Version } from "./types";

/** Stable path for an editable unit: "summary", "experience.0.2", "projects.1.0". */
export type UnitPath = string;

export function bulletText(v: Version | null, path: UnitPath, b: Bullet): string {
  if (!v) return b.tailored || b.original;
  if (v.edits[path] !== undefined) return v.edits[path];
  return v.rejected[path] ? b.original : b.tailored || b.original;
}

export function summaryText(v: Version | null, r: TailoredResume): string {
  if (v?.edits.summary !== undefined) return v.edits.summary;
  if (v?.rejected.summary) return r.summary.original;
  return r.summary.tailored || r.summary.original;
}

/** Apply accept/reject decisions and manual edits → the resume the user will download. */
export function effectiveResume(v: Version): TailoredResume {
  const r: TailoredResume = structuredClone(v.result.resume);
  r.summary.tailored = summaryText(v, v.result.resume);
  (["experience", "projects"] as const).forEach((key) => {
    r[key].forEach((item, i) => {
      item.bullets.forEach((b, j) => {
        b.tailored = bulletText(v, `${key}.${i}.${j}`, v.result.resume[key][i].bullets[j]);
      });
    });
  });
  return r;
}

export function resumeToText(r: TailoredResume): string {
  const out: string[] = [];
  const join = (...p: string[]) => p.filter((x) => x && x.trim()).join(" | ");
  if (r.candidate.name) out.push(r.candidate.name);
  if (r.candidate.headline) out.push(r.candidate.headline);
  const c = r.candidate.contact;
  const contact = join(c.email, c.phone, c.location, ...c.links.map((l) => l.url));
  if (contact) out.push(contact);
  if (r.summary.tailored || r.summary.original) out.push("", "SUMMARY", r.summary.tailored || r.summary.original);
  if (r.skills.groups.length) {
    out.push("", "SKILLS");
    r.skills.groups.forEach((g) => out.push(g.category ? `${g.category}: ${g.items.join(", ")}` : g.items.join(", ")));
  }
  if (r.experience.length) {
    out.push("", "EXPERIENCE");
    r.experience.forEach((e) => {
      out.push(join([e.title, e.company].filter(Boolean).join(" — "), e.location, e.dates));
      e.bullets.forEach((b) => out.push(`• ${b.tailored || b.original}`));
    });
  }
  if (r.projects.length) {
    out.push("", "PROJECTS");
    r.projects.forEach((p) => {
      out.push(join(p.name, p.tech.join(", "), p.dates, p.link));
      p.bullets.forEach((b) => out.push(`• ${b.tailored || b.original}`));
    });
  }
  if (r.education.length) {
    out.push("", "EDUCATION");
    r.education.forEach((e) => {
      out.push(join([e.degree, e.institution].filter(Boolean).join(" — "), e.location, e.dates));
      e.details.forEach((d) => out.push(`• ${d}`));
    });
  }
  if (r.certifications.length) out.push("", "CERTIFICATIONS", ...r.certifications.map((c) => `• ${c}`));
  r.additional_sections.forEach((s) => s.items.length && out.push("", (s.title || "Additional").toUpperCase(), ...s.items.map((i) => `• ${i}`)));
  return out.join("\n").trim();
}

export function changeCount(r: TailoredResume): { changed: number; total: number } {
  let changed = 0;
  let total = 0;
  if (r.summary.tailored || r.summary.original) {
    total++;
    if (r.summary.tailored.trim() !== r.summary.original.trim()) changed++;
  }
  [...r.experience, ...r.projects].forEach((item) =>
    item.bullets.forEach((b) => {
      total++;
      if (b.tailored && b.tailored.trim() !== b.original.trim()) changed++;
    }),
  );
  return { changed, total };
}

export type Flag = { kind: "number" | "skill" | "copied" | "drift" | "other"; values: string[] };

export function parseFlag(flag: string): Flag {
  const [kind, rest = ""] = flag.split(":");
  const values = rest.split(",").filter(Boolean);
  if (kind === "unverified_number") return { kind: "number", values };
  if (kind === "unverified_skill") return { kind: "skill", values };
  if (kind === "copied_from_jd") return { kind: "copied", values };
  if (kind === "low_grounding") return { kind: "drift", values };
  return { kind: "other", values };
}

/** Human-readable note for a guardrail flag. */
export function flagNote(f: Flag): string {
  if (f.kind === "number") return `${f.values.join(", ")} isn't in your original resume`;
  if (f.kind === "skill") return `${f.values.join(", ")} isn't mentioned in your original resume`;
  if (f.kind === "copied") return "reads like it was copied from the job post";
  if (f.kind === "drift") return "drifted far from your original — make sure it's still accurate";
  return "verify this line";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
