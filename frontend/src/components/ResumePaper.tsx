"use client";

import { useEffect, useRef } from "react";
import { PenLine } from "lucide-react";
import type { Bullet, TailoredResume, Version } from "@/lib/types";
import { bulletText, flagNote, parseFlag, summaryText } from "@/lib/resume";
import { Highlight } from "./highlight";
import { cx } from "./ui";

interface Props {
  resume: TailoredResume;
  version: Version | null;
  re: RegExp | null;
  streaming?: boolean;
  editable?: boolean;
  onEdit?: (path: string, text: string) => void;
  compact?: boolean;
}

function AutoTextarea({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [value]);
  return (
    <textarea
      ref={ref}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={1}
      className="w-full resize-none rounded-sm bg-blue-wash/60 px-1 py-0.5 outline-none ring-1 ring-blue/40 focus:ring-2 focus:ring-blue"
    />
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 border-b border-ink/70 pb-0.5 font-serif text-[13px] font-semibold tracking-[0.08em] text-ink [font-variant:small-caps]">
      {children}
    </h3>
  );
}

function Flags({ b }: { b: Bullet }) {
  if (!b.flags?.length) return null;
  const notes = b.flags.map(parseFlag).map(flagNote);
  return (
    <span className="ml-1 inline-flex items-center gap-1 rounded-sm bg-red-wash px-1 align-[1px] font-sans text-[11.5px] font-medium text-red" title={notes.join("; ")}>
      <PenLine className="size-3" aria-hidden />
      Check: {notes.join("; ")}
    </span>
  );
}

export function ResumePaper({ resume: r, version, re, streaming, editable, onEdit, compact }: Props) {
  const c = r.candidate?.contact ?? { email: "", phone: "", location: "", links: [] };
  const contact = [c.email, c.phone, c.location, ...(c.links ?? []).map((l) => l?.url ?? "")].filter(Boolean);
  const summary = summaryText(version, r);

  const bullets = (key: "experience" | "projects", i: number, list: Bullet[]) => (
    <ul className="ml-4 mt-0.5 list-disc space-y-0.5 marker:text-ink-2">
      {list.map((b, j) => {
        const path = `${key}.${i}.${j}`;
        const text = bulletText(version, path, b);
        if (!text) return null;
        return (
          <li key={j} className={cx(streaming && "ink-in")}>
            {editable && onEdit ? (
              <AutoTextarea label={`Edit bullet ${j + 1}`} value={text} onChange={(v) => onEdit(path, v)} />
            ) : (
              <>
                <Highlight text={text} re={re} />
                {!version?.rejected[path] && version?.edits[path] === undefined && <Flags b={b} />}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );

  const roleLine = (left: React.ReactNode, right: string, sub?: string) => (
    <div className="mt-2.5 first:mt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <div className="font-semibold">{left}</div>
        {right && <div className="text-[13px] text-ink-2 tabular-nums">{right}</div>}
      </div>
      {sub && <div className="text-[13px] italic text-ink-2">{sub}</div>}
    </div>
  );

  return (
    <article
      className={cx("paper paper-text mx-auto w-full text-ink", compact ? "max-w-none px-5 py-6 text-[13px]" : "max-w-[800px] px-5 py-7 sm:px-12 sm:py-11", streaming && "caret-host")}
      aria-busy={streaming}
    >
      <header className="mb-4 text-center">
        {r.candidate?.name ? (
          <h2 className={cx("font-serif font-semibold tracking-tight", compact ? "text-xl" : "text-[28px] leading-tight")}>{r.candidate.name}</h2>
        ) : (
          streaming && <div className="mx-auto h-7 w-48 animate-pulse rounded bg-desk-2" />
        )}
        {r.candidate?.headline && <p className="mt-0.5 text-ink-2">{r.candidate.headline}</p>}
        {contact.length > 0 && <p className="mt-1 break-words text-[12.5px] text-ink-2">{contact.join("  |  ")}</p>}
      </header>

      <div className="space-y-5">
      {summary && (
        <section>
          <Heading>Summary</Heading>
          {editable && onEdit ? (
            <AutoTextarea label="Edit summary" value={summary} onChange={(v) => onEdit("summary", v)} />
          ) : (
            <p className={cx(streaming && "ink-in")}>
              <Highlight text={summary} re={re} />
            </p>
          )}
        </section>
      )}

      {r.skills?.groups?.some((g) => g?.items?.length) && (
        <section>
          <Heading>Skills</Heading>
          <div className="space-y-0.5">
            {r.skills.groups.map((g, i) =>
              g?.items?.length ? (
                <p key={i}>
                  {g.category && <span className="font-semibold">{g.category}: </span>}
                  <Highlight text={g.items.join(", ")} re={re} />
                </p>
              ) : null,
            )}
          </div>
        </section>
      )}

      {r.experience?.length > 0 && (
        <section>
          <Heading>Experience</Heading>
          {r.experience.map((e, i) => (
            <div key={i}>
              {roleLine(
                <>
                  {e.title}
                  {e.company && <span className="font-normal"> — {e.company}</span>}
                </>,
                e.dates,
                e.location,
              )}
              {bullets("experience", i, e.bullets ?? [])}
            </div>
          ))}
        </section>
      )}

      {r.projects?.length > 0 && (
        <section>
          <Heading>Projects</Heading>
          {r.projects.map((p, i) => (
            <div key={i}>
              {roleLine(
                <>
                  {p.name}
                  {p.link && (
                    <a href={p.link.startsWith("http") ? p.link : `https://${p.link}`} target="_blank" rel="noreferrer" className="ml-2 font-sans text-[12px] font-normal text-blue underline-offset-2 hover:underline">
                      link
                    </a>
                  )}
                </>,
                p.dates,
                p.tech?.join(", "),
              )}
              {bullets("projects", i, p.bullets ?? [])}
            </div>
          ))}
        </section>
      )}

      {r.education?.length > 0 && (
        <section>
          <Heading>Education</Heading>
          {r.education.map((ed, i) => (
            <div key={i}>
              {roleLine(
                <>
                  {ed.degree}
                  {ed.institution && <span className="font-normal"> — {ed.institution}</span>}
                </>,
                ed.dates,
                ed.location,
              )}
              {ed.details?.length > 0 && <ul className="ml-4 list-disc">{ed.details.map((d, j) => <li key={j}>{d}</li>)}</ul>}
            </div>
          ))}
        </section>
      )}

      {r.certifications?.length > 0 && (
        <section>
          <Heading>Certifications</Heading>
          <ul className="ml-4 list-disc">{r.certifications.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </section>
      )}

      {r.additional_sections?.map((s, i) =>
        s?.items?.length ? (
          <section key={i}>
            <Heading>{s.title || "Additional"}</Heading>
            <ul className="ml-4 list-disc">{s.items.map((x, j) => <li key={j}>{x}</li>)}</ul>
          </section>
        ) : null,
      )}
      </div>

      {streaming && <span className="caret" aria-hidden />}
    </article>
  );
}

/** The parsed original resume, shown before tailoring. */
export function OriginalPaper({ text, re }: { text: string; re: RegExp | null }) {
  return (
    <article className="paper paper-text mx-auto w-full max-w-[800px] whitespace-pre-wrap px-5 py-7 text-ink sm:px-12 sm:py-11">
      {text.split("\n").map((line, i) => {
        const t = line.trim();
        const isHeading = t.length > 2 && t.length < 40 && !t.startsWith("•") && t === t.toUpperCase() && /[A-Z]/.test(t);
        return isHeading ? (
          <h3 key={i} className="mb-1 mt-4 border-b border-ink/70 font-semibold tracking-[0.08em] [font-variant:small-caps] first:mt-0">
            {t.toLowerCase()}
          </h3>
        ) : (
          <div key={i} className={cx(!t && "h-2")}>
            <Highlight text={line} re={re} />
          </div>
        );
      })}
    </article>
  );
}
