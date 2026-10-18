"use client";

import { useMemo, useState } from "react";
import type { TailoredResume, Version } from "@/lib/types";
import { effectiveResume } from "@/lib/resume";
import { SideBySide } from "./ChangesView";
import { ResumePaper } from "./ResumePaper";
import { cx } from "./ui";

const ORIGINAL = "__original__";

/** The uploaded wording, expressed as a resume so it can be compared like a version. */
function originalOf(v: Version): TailoredResume {
  const r: TailoredResume = structuredClone(v.result.resume);
  r.summary.tailored = r.summary.original;
  r.skills.groups = r.skills.original.length ? [{ category: "", items: r.skills.original }] : r.skills.groups;
  [...r.experience, ...r.projects].forEach((it) => {
    it.bullets = it.bullets.filter((b) => b.original.trim()).map((b) => ({ ...b, tailored: b.original }));
  });
  return r;
}

function resumeOf(v: Version | null, active: Version): TailoredResume {
  if (!v) return originalOf(active);
  const r = effectiveResume(v);
  if (!v.result.meta.sections.includes("summary")) r.summary.tailored = "";
  return r;
}

interface Row {
  key: string;
  group: string;
  label: string;
  a: string;
  b: string;
}

function rowsFor(a: TailoredResume, b: TailoredResume): Row[] {
  const rows: Row[] = [];
  const sa = a.summary.tailored || "";
  const sb = b.summary.tailored || "";
  if (sa || sb) rows.push({ key: "summary", group: "Summary", label: "", a: sa, b: sb });
  const skills = (r: TailoredResume) => r.skills.groups.map((g) => (g.category ? `${g.category}: ` : "") + g.items.join(", ")).join("\n");
  rows.push({ key: "skills", group: "Skills", label: "", a: skills(a), b: skills(b) });
  (["experience", "projects"] as const).forEach((k) => {
    const n = Math.max(a[k].length, b[k].length);
    for (let i = 0; i < n; i++) {
      const ia = a[k][i];
      const ib = b[k][i];
      const it = ib ?? ia;
      const title = "title" in it ? [it.title, it.company].filter(Boolean).join(" — ") : it.name;
      const used = new Set<number>();
      const ab = ia?.bullets ?? [];
      (ib?.bullets ?? []).forEach((bb, j) => {
        // Pair bullets by the original line they came from, so reordering doesn't look like a rewrite.
        let m = ab.findIndex((x, xi) => !used.has(xi) && x.original && x.original === bb.original);
        if (m < 0 && !used.has(j) && j < ab.length && !bb.original) m = j;
        if (m >= 0) used.add(m);
        rows.push({ key: `${k}.${i}.${j}`, group: title, label: `Bullet ${j + 1}`, a: m >= 0 ? ab[m].tailored || ab[m].original : "", b: bb.tailored || bb.original });
      });
      ab.forEach((x, xi) => !used.has(xi) && rows.push({ key: `${k}.${i}.a${xi}`, group: title, label: "Only in left", a: x.tailored || x.original, b: "" }));
    }
  });
  return rows;
}

function Stat({ v }: { v: Version | null }) {
  if (!v) return <span className="text-sm text-muted">as uploaded</span>;
  const s = v.result.scores;
  return (
    <span className="flex gap-3 text-sm">
      <span>
        Match <b className="tabular-nums">{s.match.after?.score ?? "—"}</b>
      </span>
      <span>
        ATS <b className="tabular-nums">{s.ats.after?.score ?? "—"}</b>
      </span>
      <span className="text-muted">
        Must-haves {s.match.after?.required_matched ?? 0}/{s.match.after?.required_total ?? 0}
      </span>
    </span>
  );
}

export function CompareView({ versions, activeKey }: { versions: Version[]; activeKey: string }) {
  const [a, setA] = useState(versions.length > 1 ? versions.find((v) => v.key !== activeKey)!.key : ORIGINAL);
  const [b, setB] = useState(activeKey);
  const [mode, setMode] = useState<"rows" | "pages">("rows");
  const [onlyDiff, setOnlyDiff] = useState(true);
  const active = versions.find((v) => v.key === activeKey) ?? versions[0];
  const va = a === ORIGINAL ? null : (versions.find((v) => v.key === a) ?? null);
  const vb = b === ORIGINAL ? null : (versions.find((v) => v.key === b) ?? active);
  const ra = useMemo(() => resumeOf(va, active), [va, active]);
  const rb = useMemo(() => resumeOf(vb, active), [vb, active]);
  const rows = useMemo(() => rowsFor(ra, rb), [ra, rb]);
  const differing = rows.filter((r) => r.a.trim() !== r.b.trim());
  const shown = onlyDiff ? differing : rows;
  const labelOf = (k: string) => (k === ORIGINAL ? "Original resume" : (versions.find((v) => v.key === k)?.label ?? ""));

  const pick = (value: string, onChange: (k: string) => void, label: string) => (
    <label className="min-w-0 flex-1 text-sm">
      <span className="mb-1 block text-muted">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-10 w-full rounded-lg border border-rule bg-paper px-2 outline-none focus:border-blue">
        <option value={ORIGINAL}>Original resume</option>
        {versions.map((v) => (
          <option key={v.key} value={v.key}>
            {v.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-rule-soft bg-paper p-4">
        {pick(a, setA, "Left")}
        {pick(b, setB, "Right")}
        <div className="flex rounded-lg bg-desk-2 p-1" role="radiogroup" aria-label="Comparison layout">
          {(["rows", "pages"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cx("rounded-md px-2.5 py-1 text-[13px]", mode === m ? "bg-paper font-medium shadow-sm" : "text-muted")}>
              {m === "rows" ? "Line by line" : "Full pages"}
            </button>
          ))}
        </div>
      </div>

      {mode === "rows" ? (
        <div className="paper px-4 py-5 sm:px-8">
          <div className="mb-3 grid gap-2 border-b border-rule-soft pb-3 sm:grid-cols-2">
            <div>
              <div className="font-medium">{labelOf(a)}</div>
              <Stat v={va} />
            </div>
            <div>
              <div className="font-medium">{labelOf(b)}</div>
              <Stat v={vb} />
            </div>
          </div>
          <div className="mb-2 flex items-center justify-between text-[13px] text-ink-2">
            <span>
              {a === b ? "Pick two different versions." : `${differing.length} of ${rows.length} lines differ.`}
            </span>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} className="accent-[var(--blue)]" />
              Only differences
            </label>
          </div>
          {shown.map((r, i) => {
            const head = i === 0 || shown[i - 1].group !== r.group ? r.group : "";
            return (
              <div key={r.key} className={cx(head && "mt-4")}>
                {head && <h3 className="mb-1 font-semibold">{head}</h3>}
                <div className="border-b border-rule-soft py-2 last:border-0">
                  {r.label && <div className="mb-1 font-sans text-xs text-muted">{r.label}</div>}
                  {r.a.trim() === r.b.trim() ? <p className="paper-text whitespace-pre-line text-ink-2">{r.b}</p> : <SideBySide before={r.a} after={r.b} beforeLabel="Left" afterLabel="Right" />}
                </div>
              </div>
            );
          })}
          {!shown.length && a !== b && <p className="py-4 text-center text-muted">These two are identical.</p>}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {[
            [a, va, ra],
            [b, vb, rb],
          ].map(([k, v, r]) => (
            <div key={k as string} className="min-w-0">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 px-1">
                <span className="font-medium">{labelOf(k as string)}</span>
                <Stat v={v as Version | null} />
              </div>
              <ResumePaper resume={r as TailoredResume} version={null} re={null} compact showSummary={!!(r as TailoredResume).summary.tailored} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
