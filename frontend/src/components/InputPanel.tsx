"use client";

import { useRef, useState } from "react";
import { AlertTriangle, FileText, RefreshCw, Trash2, Upload } from "lucide-react";
import type { ParsedResume, Section, Tone } from "@/lib/types";
import { ALL_SECTIONS } from "@/lib/types";
import { formatBytes } from "@/lib/resume";
import { Segmented, cx } from "./ui";

export const MIN_JD = 100;
export const MAX_JD = 20_000;
export const MAX_MB = 5;
const ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ---------------------------------------------------------------------------
export function JDInput({
  value,
  onChange,
  disabled,
  onSubmit,
  touched,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  onSubmit?: () => void;
  touched: boolean;
}) {
  const len = value.trim().length;
  const error = !len ? "Paste the job description to continue." : len < MIN_JD ? `Add a bit more — at least ${MIN_JD} characters (${len} so far).` : len > MAX_JD ? `Too long — keep it under ${MAX_JD.toLocaleString()} characters.` : null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label htmlFor="jd" className="font-medium">
          Job description
        </label>
        <span className={cx("text-xs tabular-nums", len > MAX_JD ? "text-red" : "text-muted")}>{len.toLocaleString()} chars</span>
      </div>
      <textarea
        id="jd"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmit?.();
        }}
        placeholder="Paste the full posting — responsibilities, requirements and nice-to-haves all help."
        aria-invalid={touched && !!error}
        aria-describedby="jd-help"
        className={cx(
          "scroll-thin block h-56 w-full resize-y rounded-lg border bg-paper px-3 py-2.5 text-[14px] leading-relaxed outline-none transition-colors placeholder:text-muted/80 focus:border-blue disabled:opacity-60 lg:h-64",
          touched && error ? "border-red" : "border-rule",
        )}
      />
      <p id="jd-help" className={cx("mt-1 text-xs", touched && error ? "text-red" : "text-muted")}>
        {touched && error ? error : "Tip: ⌘/Ctrl + Enter tailors your resume."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function validateFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".doc")) return "Legacy .doc files aren't supported. Save it as PDF or DOCX and try again.";
  if (!name.endsWith(".pdf") && !name.endsWith(".docx")) return "Please upload a PDF or DOCX file.";
  if (file.size === 0) return "This file is empty.";
  if (file.size > MAX_MB * 1024 * 1024) return `This file is ${formatBytes(file.size)}. The limit is ${MAX_MB} MB.`;
  return null;
}

export function ResumeUpload({
  parsed,
  uploading,
  progress,
  error,
  pendingFile,
  onFile,
  onClear,
  disabled,
}: {
  parsed: ParsedResume | null;
  uploading: boolean;
  progress: number;
  error: string | null;
  pendingFile: { name: string; size: number } | null;
  onFile: (f: File) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const pick = (files: FileList | null) => {
    if (files?.length) onFile(files[0]);
    if (input.current) input.current.value = "";
  };

  const fileInput = <input ref={input} type="file" accept={ACCEPT} className="sr-only" onChange={(e) => pick(e.target.files)} tabIndex={-1} aria-hidden />;

  if (parsed && !uploading) {
    return (
      <div>
        <div className="mb-1.5 font-medium">Resume</div>
        <div className="rounded-lg border border-rule bg-paper p-3">
          <div className="flex items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-md bg-blue-wash text-blue">
              <FileText className="size-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium" title={parsed.filename}>
                {parsed.filename}
              </div>
              <div className="text-xs text-muted">
                {parsed.size_bytes ? `${formatBytes(parsed.size_bytes)} · ` : ""}
                {parsed.file_type?.toUpperCase()}
                {parsed.pages ? ` · ${parsed.pages} page${parsed.pages > 1 ? "s" : ""}` : ""} · {parsed.word_count} words
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="rounded-md p-1.5 text-muted hover:bg-desk-2 hover:text-ink disabled:opacity-50" title="Replace file" aria-label="Replace file">
                <RefreshCw className="size-4" />
              </button>
              <button type="button" disabled={disabled} onClick={onClear} className="rounded-md p-1.5 text-muted hover:bg-red-wash hover:text-red disabled:opacity-50" title="Remove file" aria-label="Remove file">
                <Trash2 className="size-4" />
              </button>
            </div>
          </div>
          {parsed.warnings?.length > 0 && (
            <ul className="mt-2.5 space-y-1 border-t border-rule-soft pt-2.5">
              {parsed.warnings.map((w, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-amber">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>
        {fileInput}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1.5 font-medium">Resume</div>
      <button
        type="button"
        disabled={disabled || uploading}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled && !uploading) pick(e.dataTransfer.files);
        }}
        className={cx(
          "flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-dashed px-4 py-6 text-center transition-colors",
          over ? "border-blue bg-blue-wash" : error ? "border-red bg-paper" : "border-rule bg-paper hover:border-ink-2",
        )}
      >
        {uploading ? (
          <>
            <div className="text-sm font-medium">Reading {pendingFile?.name ?? "file"}…</div>
            <div className="h-1.5 w-48 overflow-hidden rounded-full bg-desk-2" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-blue transition-[width]" style={{ width: `${Math.max(progress, 8)}%` }} />
            </div>
            <div className="text-xs text-muted">{progress < 100 ? `Uploading ${progress}%` : "Extracting text"}</div>
          </>
        ) : (
          <>
            <Upload className="size-5 text-blue" aria-hidden />
            <div className="text-sm">
              <span className="font-medium text-blue">Choose a file</span> or drop it here
            </div>
            <div className="text-xs text-muted">PDF or DOCX, up to {MAX_MB} MB</div>
          </>
        )}
      </button>
      {error && (
        <p role="alert" className="mt-1.5 flex gap-1.5 text-xs text-red">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {fileInput}
    </div>
  );
}

// ---------------------------------------------------------------------------
const SECTION_LABEL: Record<Section, string> = { summary: "Summary", skills: "Skills", experience: "Experience", projects: "Projects" };
export const TONES: { value: Tone; label: string; hint: string }[] = [
  { value: "balanced", label: "Balanced", hint: "Even mix of technical depth and impact" },
  { value: "technical", label: "Technical", hint: "Foreground stack, architecture and scale" },
  { value: "impact", label: "Impact", hint: "Lead every bullet with the outcome" },
  { value: "leadership", label: "Leadership", hint: "Ownership, mentoring, collaboration" },
  { value: "concise", label: "Concise", hint: "Tighter bullets and a two-line summary" },
];

export function Options({
  sections,
  tone,
  extra,
  onSections,
  onTone,
  onExtra,
  disabled,
}: {
  sections: Section[];
  tone: Tone;
  extra: string;
  onSections: (s: Section[]) => void;
  onTone: (t: Tone) => void;
  onExtra: (s: string) => void;
  disabled?: boolean;
}) {
  const toggle = (s: Section) => {
    const next = sections.includes(s) ? sections.filter((x) => x !== s) : ALL_SECTIONS.filter((x) => x === s || sections.includes(x));
    if (next.length) onSections(next);
  };
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 font-medium">Sections to rewrite</legend>
        <div className="flex flex-wrap gap-1.5">
          {ALL_SECTIONS.map((s) => {
            const on = sections.includes(s);
            return (
              <button
                key={s}
                type="button"
                disabled={disabled || (on && sections.length === 1)}
                aria-pressed={on}
                onClick={() => toggle(s)}
                title={on && sections.length === 1 ? "Keep at least one section selected" : undefined}
                className={cx(
                  "rounded-full border px-3 py-1 text-[13px] transition-colors disabled:cursor-not-allowed",
                  on ? "border-blue bg-blue-wash text-blue-ink" : "border-rule bg-paper text-muted hover:text-ink",
                )}
              >
                {on ? "✓ " : ""}
                {SECTION_LABEL[s]}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-muted">Unselected sections stay exactly as written.</p>
      </fieldset>

      <div>
        <div className="mb-1.5 font-medium" id="tone-label">
          Emphasis
        </div>
        <Segmented label="Emphasis" value={tone} options={TONES} onChange={onTone} disabled={disabled} />
        <p className="mt-1 text-xs text-muted">{TONES.find((t) => t.value === tone)?.hint}.</p>
      </div>

      <div>
        <label htmlFor="extra" className="mb-1.5 block font-medium">
          Anything to keep in mind? <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="extra"
          value={extra}
          disabled={disabled}
          maxLength={500}
          onChange={(e) => onExtra(e.target.value)}
          placeholder="e.g. Emphasise my backend work over frontend"
          className="h-10 w-full rounded-lg border border-rule bg-paper px-3 text-sm outline-none focus:border-blue disabled:opacity-60"
        />
      </div>
    </div>
  );
}
