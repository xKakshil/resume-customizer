"use client";

import { useMemo, useState } from "react";
import { diffWords } from "diff";
import { ArrowUp, Check, PenLine, RotateCcw, Undo2 } from "lucide-react";
import type { Bullet, Version } from "@/lib/types";
import { bulletText, changeCount, parseFlag, summaryText } from "@/lib/resume";
import { cx } from "./ui";

export function DiffText({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffWords(before || "", after || ""), [before, after]);
  return (
    <>
      {parts.map((p, i) =>
        p.added ? (
          <ins key={i} className="mark-ins">
            {p.value}
          </ins>
        ) : p.removed ? (
          <del key={i} className="mark-del">
            {p.value}
          </del>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </>
  );
}

type Mode = "marked" | "side";

function Decision({ rejected, onToggle, edited }: { rejected: boolean; onToggle: () => void; edited: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-sans text-xs font-medium transition-colors",
        rejected ? "border-rule text-muted hover:text-ink" : "border-green/40 bg-green-wash text-green",
      )}
      aria-pressed={!rejected}
      title={rejected ? "Use the tailored version of this line" : "Revert this line to your original wording"}
    >
      {rejected ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
      {edited ? "Edited" : rejected ? "Kept original" : "Accepted"}
    </button>
  );
}

function Unit({
  label,
  original,
  current,
  tailored,
  rejected,
  edited,
  onToggle,
  mode,
  moved,
  flags,
}: {
  label?: string;
  original: string;
  current: string;
  tailored: string;
  rejected: boolean;
  edited: boolean;
  onToggle: () => void;
  mode: Mode;
  moved?: number | null;
  flags?: string[];
}) {
  const changed = original.trim() !== tailored.trim();
  const isNew = !original.trim();
  return (
    <div className="border-b border-rule-soft py-3 last:border-0">
      <div className="mb-1 flex flex-wrap items-center gap-2 font-sans text-xs text-muted">
        {label && <span className="font-medium text-ink-2">{label}</span>}
        {isNew ? <span className="text-blue">New</span> : changed ? <span className="text-blue">Rewritten</span> : <span>Unchanged</span>}
        {moved ? (
          <span className="inline-flex items-center gap-0.5 text-blue">
            <ArrowUp className="size-3" /> moved up {moved}
          </span>
        ) : null}
        {flags?.map((f) => {
          const pf = parseFlag(f);
          return (
            <span key={f} className="inline-flex items-center gap-1 rounded-sm bg-red-wash px-1 text-red">
              <PenLine className="size-3" /> {pf.kind === "copied" ? "copied from job post" : `check ${pf.values.join(", ")}`}
            </span>
          );
        })}
        <span className="flex-1" />
        {(changed || edited) && <Decision rejected={rejected} onToggle={onToggle} edited={edited} />}
      </div>
      {mode === "marked" || !changed ? (
        <p className="paper-text">{changed || edited ? <DiffText before={original} after={current} /> : current}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <p className="paper-text rounded-md bg-desk/60 p-2 text-ink-2">
            <span className="mb-0.5 block font-sans text-[11px] text-muted">Before</span>
            {original || <em className="text-muted">(none)</em>}
          </p>
          <p className="paper-text rounded-md bg-blue-wash/50 p-2">
            <span className="mb-0.5 block font-sans text-[11px] text-muted">After</span>
            {current}
          </p>
        </div>
      )}
    </div>
  );
}

export function ChangesView({
  version,
  resumeText,
  onToggle,
  onRevertAll,
}: {
  version: Version;
  resumeText: string;
  onToggle: (path: string) => void;
  onRevertAll: (rejectAll: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>("marked");
  const [onlyChanged, setOnlyChanged] = useState(true);
  const r = version.result.resume;
  const { changed, total } = changeCount(r);
  const low = resumeText.toLowerCase();

  const originalRank = (bullets: Bullet[]) => {
    const pos = bullets.map((b) => {
      const i = low.indexOf(b.original.toLowerCase().slice(0, 40));
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    });
    const sorted = [...pos].sort((a, b) => a - b);
    return pos.map((p) => sorted.indexOf(p));
  };

  const groups = (key: "experience" | "projects") =>
    r[key].map((item, i) => {
      const ranks = originalRank(item.bullets);
      const title = "title" in item ? [item.title, item.company].filter(Boolean).join(" — ") : item.name;
      const units = item.bullets.map((b, j) => {
        const path = `${key}.${i}.${j}`;
        const moved = ranks[j] !== Number.MAX_SAFE_INTEGER && ranks[j] > j ? ranks[j] - j : null;
        return { b, j, path, moved, changed: b.original.trim() !== (b.tailored || b.original).trim() || !!moved };
      });
      const visible = onlyChanged ? units.filter((u) => u.changed || version.edits[u.path] !== undefined) : units;
      if (!visible.length) return null;
      return (
        <section key={`${key}-${i}`} className="mt-5">
          <h3 className="font-semibold">{title}</h3>
          {item.rationale && <p className="mt-0.5 text-[13px] text-muted">{item.rationale}</p>}
          <div className="mt-1">
            {visible.map(({ b, j, path, moved }) => (
              <Unit
                key={path}
                label={`Bullet ${j + 1}`}
                original={b.original}
                tailored={b.tailored || b.original}
                current={bulletText(version, path, b)}
                rejected={!!version.rejected[path]}
                edited={version.edits[path] !== undefined}
                onToggle={() => onToggle(path)}
                mode={mode}
                moved={moved}
                flags={version.rejected[path] ? [] : b.flags}
              />
            ))}
          </div>
        </section>
      );
    });

  const origSkills = r.skills.original.join(", ");
  const newSkills = r.skills.groups.map((g) => g.items.join(", ")).join(", ");
  const anyRejected = Object.values(version.rejected).some(Boolean);

  return (
    <div className="paper mx-auto w-full max-w-[800px] px-5 py-6 sm:px-10 sm:py-8">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold">What changed</h2>
          <p className="text-sm text-muted">
            {changed} of {total} lines rewritten. <ins className="mark-ins">Blue</ins> is new wording, <del className="mark-del">red</del> was removed. Accept or revert each line — downloads use your choices.
          </p>
        </div>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2 border-b border-rule-soft pb-3 text-sm">
        <div className="flex rounded-lg bg-desk-2 p-1" role="radiogroup" aria-label="Diff layout">
          {(["marked", "side"] as Mode[]).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cx("rounded-md px-2.5 py-1 text-[13px]", mode === m ? "bg-paper font-medium shadow-sm" : "text-muted")}>
              {m === "marked" ? "Marked up" : "Side by side"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} className="accent-[var(--blue)]" />
          Only show changes
        </label>
        <span className="flex-1" />
        <button onClick={() => onRevertAll(!anyRejected)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-ink-2 hover:bg-desk-2">
          <RotateCcw className="size-3.5" /> {anyRejected ? "Accept all" : "Revert all"}
        </button>
      </div>

      {(r.summary.original || r.summary.tailored) && (
        <section className="mt-3">
          <h3 className="font-semibold">Summary</h3>
          {r.summary.rationale && <p className="mt-0.5 text-[13px] text-muted">{r.summary.rationale}</p>}
          <Unit
            original={r.summary.original}
            tailored={r.summary.tailored || r.summary.original}
            current={summaryText(version, r)}
            rejected={!!version.rejected.summary}
            edited={version.edits.summary !== undefined}
            onToggle={() => onToggle("summary")}
            mode={mode}
          />
        </section>
      )}

      {(origSkills || newSkills) && (
        <section className="mt-5">
          <h3 className="font-semibold">Skills</h3>
          {r.skills.rationale && <p className="mt-0.5 text-[13px] text-muted">{r.skills.rationale}</p>}
          <div className="mt-2 space-y-1 text-[13.5px]">
            {r.skills.groups.map((g, i) => (
              <p key={i} className="paper-text">
                <span className="font-semibold">{g.category}:</span> {g.items.join(", ")}
              </p>
            ))}
          </div>
          {version.result.guardrails.removed_skills.length > 0 && (
            <p className="mt-2 rounded-md bg-amber-wash px-2.5 py-1.5 text-[13px] text-amber">
              Removed because your resume doesn&apos;t show them: {version.result.guardrails.removed_skills.join(", ")}. They&apos;re listed under missing keywords instead.
            </p>
          )}
        </section>
      )}

      {groups("experience")}
      {groups("projects")}

      {r.change_log.length > 0 && (
        <section className="mt-6 border-t border-rule-soft pt-4">
          <h3 className="font-semibold">Editor&apos;s notes</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[13.5px] text-ink-2">
            {r.change_log.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
