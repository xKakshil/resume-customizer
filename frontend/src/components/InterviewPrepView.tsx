"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Copy, Download, MessagesSquare, RotateCw } from "lucide-react";
import { ApiError, history, interviewPrep } from "@/lib/api";
import type { InterviewPrep, InterviewQuestion } from "@/lib/types";
import { Button, Spinner, copyText, cx, useToast } from "./ui";

const CATS: { key: InterviewQuestion["category"] | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "technical", label: "Technical" },
  { key: "project", label: "Your projects" },
  { key: "behavioral", label: "Behavioural" },
  { key: "role", label: "Role & company" },
];
const CAT_STYLE: Record<InterviewQuestion["category"], string> = {
  technical: "bg-blue-wash text-blue-ink",
  project: "bg-green-wash text-green",
  behavioral: "bg-amber-wash text-amber",
  role: "bg-desk-2 text-ink-2",
};

export function prepToMarkdown(p: InterviewPrep, title: string): string {
  const out = [`# Interview prep — ${title}`, "", "## Why you fit", ...p.role_fit.map((x) => `- ${x}`), "", "## Likely questions"];
  p.questions.forEach((q, i) => {
    out.push("", `### ${i + 1}. ${q.question}`, `*${q.category}* — ${q.why_they_ask}`);
    if (q.based_on) out.push(`Draw on: ${q.based_on}`);
    out.push(...q.answer_points.map((a) => `- ${a}`));
  });
  if (p.skill_gaps.length) out.push("", "## Prepare for these gaps", ...p.skill_gaps.map((g) => `- **${g.skill}** — ${g.why_it_matters} ${g.how_to_prepare}`));
  if (p.questions_to_ask.length) out.push("", "## Questions to ask them", ...p.questions_to_ask.map((q) => `- ${q}`));
  return out.join("\n") + "\n";
}

function QuestionCard({ q, n, open, onToggle }: { q: InterviewQuestion; n: number; open: boolean; onToggle: () => void }) {
  return (
    <li className="border-b border-rule-soft last:border-0">
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-3 py-3 text-left">
        <span className="mt-0.5 w-6 shrink-0 font-serif text-sm tabular-nums text-muted">{n}.</span>
        <span className="min-w-0 flex-1">
          <span className="font-serif text-[15.5px] leading-snug">{q.question}</span>
          <span className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span className={cx("rounded-sm px-1.5 py-0.5 font-medium capitalize", CAT_STYLE[q.category])}>{q.category === "behavioral" ? "behavioural" : q.category}</span>
            {q.based_on && <span className="text-muted">draw on: {q.based_on}</span>}
          </span>
        </span>
        <ChevronDown className={cx("mt-1 size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="pb-4 pl-9 pr-2">
          {q.why_they_ask && <p className="text-[13.5px] italic text-muted">{q.why_they_ask}</p>}
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px] text-ink-2">
            {q.answer_points.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export function InterviewPrepView({
  jd,
  resumeText,
  title,
  initial,
  runId,
  signedIn,
  onChange,
}: {
  jd: string;
  resumeText: string;
  title: string;
  initial?: InterviewPrep;
  runId?: number;
  signedIn: boolean;
  onChange: (p: InterviewPrep) => void;
}) {
  const toast = useToast();
  const [prep, setPrep] = useState<InterviewPrep | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<(typeof CATS)[number]["key"]>("all");
  const [open, setOpen] = useState<number | null>(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const generate = async () => {
    setBusy(true);
    setError(null);
    abort.current = new AbortController();
    try {
      const p = await interviewPrep(jd, resumeText, 10, abort.current.signal);
      setPrep(p);
      setOpen(0);
      onChange(p);
      if (runId && signedIn) history.attachInterviewPrep(runId, p).catch(() => {});
    } catch (e) {
      if ((e as ApiError).code !== "aborted") setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => (prep ? prep.questions.map((q, i) => ({ q, i })).filter(({ q }) => cat === "all" || q.category === cat) : []), [prep, cat]);

  if (!prep) {
    return (
      <div className="paper mx-auto w-full max-w-[800px] px-6 py-10 sm:px-12">
        <MessagesSquare className="size-6 text-blue" aria-hidden />
        <h2 className="mt-3 font-serif text-[24px] font-semibold leading-tight">Prepare for the interview</h2>
        <p className="mt-2 max-w-prose text-ink-2">
          Get the questions this role is most likely to ask — technical, project deep-dives, behavioural and role fit — each with answer points drawn from your own resume, plus the gaps worth preparing and smart questions to ask back.
        </p>
        <div className="mt-6 flex items-center gap-3">
          <Button variant="primary" onClick={generate} loading={busy}>
            {busy ? "Preparing questions…" : "Prepare me"}
          </Button>
          {busy && <span className="text-sm text-muted">Usually 10–20 seconds.</span>}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red">
            {error}
          </p>
        )}
      </div>
    );
  }

  const md = () => prepToMarkdown(prep, title);
  return (
    <div className="mx-auto w-full max-w-[800px] space-y-4">
      <div className="no-print flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap rounded-lg bg-desk-2 p-1" role="radiogroup" aria-label="Question type">
          {CATS.map((c) => {
            const count = c.key === "all" ? prep.questions.length : prep.questions.filter((q) => q.category === c.key).length;
            if (!count) return null;
            return (
              <button key={c.key} role="radio" aria-checked={cat === c.key} onClick={() => setCat(c.key)} className={cx("rounded-md px-2.5 py-1 text-[13px]", cat === c.key ? "bg-paper font-medium shadow-sm" : "text-muted hover:text-ink")}>
                {c.label} <span className="tabular-nums text-muted">{count}</span>
              </button>
            );
          })}
        </div>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const ok = await copyText(md());
            toast(ok ? "success" : "error", ok ? "Interview prep copied as Markdown." : "Couldn't access the clipboard.");
          }}
        >
          <Copy className="size-3.5" /> Copy
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([md()], { type: "text/markdown" }));
            const a = Object.assign(document.createElement("a"), { href: url, download: "interview-prep.md" });
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download className="size-3.5" /> .md
        </Button>
        <Button size="sm" variant="ghost" onClick={generate} disabled={busy}>
          {busy ? <Spinner /> : <RotateCw className="size-3.5" />} New set
        </Button>
      </div>

      {prep.role_fit.length > 0 && (
        <section className="rounded-lg border border-rule-soft bg-paper p-4 sm:p-5">
          <h2 className="text-[17px] font-semibold">Why you fit — lead with these</h2>
          <ul className="mt-2 space-y-1.5 text-[14px] text-ink-2">
            {prep.role_fit.map((x, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-hl" style={{ boxShadow: "0 0 0 1px var(--amber)" }} aria-hidden />
                {x}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="paper px-5 py-4 sm:px-8">
        <h2 className="pt-2 text-[17px] font-semibold">Likely questions</h2>
        <p className="text-[13px] text-muted">Most likely first. Open a question for what the interviewer is checking and points from your resume to cover.</p>
        <ol className="mt-1">
          {shown.map(({ q, i }) => (
            <QuestionCard key={i} q={q} n={i + 1} open={open === i} onToggle={() => setOpen(open === i ? null : i)} />
          ))}
        </ol>
      </section>

      {prep.skill_gaps.length > 0 && (
        <section className="rounded-lg border border-rule-soft bg-paper p-4 sm:p-5">
          <h2 className="text-[17px] font-semibold">Gaps to prepare for</h2>
          <p className="text-[13px] text-muted">The job asks for these and your resume doesn&apos;t show them — be ready to talk about how you&apos;d ramp up.</p>
          <ul className="mt-3 space-y-3">
            {prep.skill_gaps.map((g) => (
              <li key={g.skill}>
                <div className="font-medium">{g.skill}</div>
                <p className="text-[13.5px] text-ink-2">{g.why_it_matters}</p>
                <p className="text-[13.5px] text-ink-2">
                  <span className="font-medium text-ink">Prepare: </span>
                  {g.how_to_prepare}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {prep.questions_to_ask.length > 0 && (
        <section className="rounded-lg border border-rule-soft bg-paper p-4 sm:p-5">
          <h2 className="text-[17px] font-semibold">Questions to ask them</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px] text-ink-2">
            {prep.questions_to_ask.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </section>
      )}
      {error && (
        <p role="alert" className="text-sm text-red">
          {error}
        </p>
      )}
    </div>
  );
}
