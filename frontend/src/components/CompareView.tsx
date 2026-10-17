"use client";

import { useMemo, useState } from "react";
import type { Version } from "@/lib/types";
import { effectiveResume, resumeToText } from "@/lib/resume";
import { DiffText } from "./ChangesView";
import { ResumePaper } from "./ResumePaper";
import { cx } from "./ui";

function Pick({ versions, value, onChange, label }: { versions: Version[]; value: string; onChange: (k: string) => void; label: string }) {
  return (
    <label className="flex-1 text-sm">
      <span className="mb-1 block text-muted">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-10 w-full rounded-lg border border-rule bg-paper px-2 outline-none focus:border-blue">
        {versions.map((v) => (
          <option key={v.key} value={v.key}>
            {v.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Stat({ v }: { v: Version }) {
  const s = v.result.scores;
  return (
    <div className="flex gap-4 text-sm">
      <span>
        Match <b className="tabular-nums">{s.match.after?.score ?? "—"}</b>
      </span>
      <span>
        ATS <b className="tabular-nums">{s.ats.after?.score ?? "—"}</b>
      </span>
      <span className="text-muted capitalize">{v.result.meta.tone}</span>
    </div>
  );
}

export function CompareView({ versions, activeKey }: { versions: Version[]; activeKey: string }) {
  const [a, setA] = useState(versions.find((v) => v.key !== activeKey)?.key ?? versions[0].key);
  const [b, setB] = useState(activeKey);
  const [mode, setMode] = useState<"diff" | "side">("diff");
  const va = versions.find((v) => v.key === a) ?? versions[0];
  const vb = versions.find((v) => v.key === b) ?? versions[versions.length - 1];
  const ta = useMemo(() => resumeToText(effectiveResume(va)), [va]);
  const tb = useMemo(() => resumeToText(effectiveResume(vb)), [vb]);

  if (versions.length < 2) {
    return (
      <div className="paper mx-auto max-w-[800px] px-6 py-10 text-center">
        <h2 className="text-lg font-semibold">Compare versions</h2>
        <p className="mx-auto mt-1 max-w-md text-muted">
          Generate another version — try a different emphasis like Technical or Impact — and compare them here line by line.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-rule-soft bg-paper p-4">
        <Pick versions={versions} value={a} onChange={setA} label="Compare" />
        <Pick versions={versions} value={b} onChange={setB} label="With" />
        <div className="flex rounded-lg bg-desk-2 p-1" role="radiogroup" aria-label="Comparison layout">
          {(["diff", "side"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cx("rounded-md px-2.5 py-1 text-[13px]", mode === m ? "bg-paper font-medium shadow-sm" : "text-muted")}>
              {m === "diff" ? "Differences" : "Side by side"}
            </button>
          ))}
        </div>
      </div>

      {mode === "diff" ? (
        <div className="paper px-5 py-6 sm:px-10">
          <div className="mb-3 flex flex-wrap justify-between gap-2 border-b border-rule-soft pb-3">
            <div>
              <del className="mark-del">{va.label}</del> <Stat v={va} />
            </div>
            <div>
              <ins className="mark-ins">{vb.label}</ins> <Stat v={vb} />
            </div>
          </div>
          {a === b ? (
            <p className="text-muted">Pick two different versions to see what differs.</p>
          ) : (
            <div className="paper-text whitespace-pre-wrap">
              <DiffText before={ta} after={tb} />
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {[va, vb].map((v) => (
            <div key={v.key} className="min-w-0">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 px-1">
                <span className="font-medium">{v.label}</span>
                <Stat v={v} />
              </div>
              <ResumePaper resume={v.result.resume} version={v} re={null} compact />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
