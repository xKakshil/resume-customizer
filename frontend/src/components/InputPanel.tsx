"use client";

import { useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ClipboardPaste, FilePlus2, FileText, Link2, RefreshCw, Trash2, Upload, X } from "lucide-react";
import type { DetectedStyle, ParsedResume, Section, SupportingDoc, Tone } from "@/lib/types";
import { formatBytes } from "@/lib/resume";
import { Button, Segmented, cx } from "./ui";

export const MIN_JD = 100;
export const MAX_JD = 20_000;
export const MAX_MB = 5;
const ACCEPT = ".pdf,.docx,.tex,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/x-tex";
const DOC_ACCEPT = ".pdf,.docx,.tex,.txt,.md";
export const MAX_DOCS = 5;

// ---------------------------------------------------------------------------
export function JDInput({
  value,
  onChange,
  disabled,
  onSubmit,
  touched,
  onPasted,
  cleanedLines,
  onUndoClean,
  onImport,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  onSubmit?: () => void;
  touched: boolean;
  onPasted?: () => void;
  cleanedLines?: number;
  onUndoClean?: () => void;
  onImport?: (url: string) => Promise<boolean>;
}) {
  const [importing, setImporting] = useState<"closed" | "open" | "busy">("closed");
  const [url, setUrl] = useState("");
  const len = value.trim().length;
  const error = !len ? "Paste the job description to continue." : len < MIN_JD ? `Add a bit more — at least ${MIN_JD} characters (${len} so far).` : len > MAX_JD ? `Too long — keep it under ${MAX_JD.toLocaleString()} characters.` : null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label htmlFor="jd" className="font-medium">
          Job description
        </label>
        <span className="flex items-baseline gap-3">
          {onImport && importing === "closed" && (
            <button type="button" disabled={disabled} onClick={() => setImporting("open")} className="inline-flex items-center gap-1 text-xs font-medium text-blue hover:underline disabled:opacity-50">
              <Link2 className="size-3.5" aria-hidden /> Import from link
            </button>
          )}
          <span className={cx("text-xs tabular-nums", len > MAX_JD ? "text-red" : "text-muted")}>{len.toLocaleString()} chars</span>
        </span>
      </div>
      {importing !== "closed" && (
        <form
          className="mb-2 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!url.trim()) return;
            setImporting("busy");
            const ok = await onImport?.(url.trim());
            setImporting(ok ? "closed" : "open");
            if (ok) setUrl("");
          }}
        >
          <input
            autoFocus
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://jobs.company.com/backend-engineer"
            aria-label="Job posting link"
            className="h-9 min-w-0 flex-1 rounded-md border border-rule bg-paper px-2.5 text-sm outline-none focus:border-blue"
          />
          <Button size="sm" type="submit" loading={importing === "busy"}>
            Import
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setImporting("closed")} aria-label="Cancel import">
            <X className="size-4" />
          </Button>
        </form>
      )}
      <textarea
        id="jd"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onPaste={() => setTimeout(() => onPasted?.(), 0)}
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
        {touched && error ? (
          error
        ) : cleanedLines ? (
          <>
            Removed {cleanedLines} line{cleanedLines > 1 ? "s" : ""} of job-board boilerplate.{" "}
            <button type="button" onClick={onUndoClean} className="font-medium text-blue hover:underline">
              Undo
            </button>
          </>
        ) : (
          "Tip: ⌘/Ctrl + Enter tailors your resume."
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function validateFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".doc")) return "Legacy .doc files aren't supported. Save it as PDF or DOCX and try again.";
  if (!/\.(pdf|docx|tex)$/.test(name)) return "Please upload a PDF, Word (.docx) or LaTeX (.tex) file.";
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
              {parsed.style?.detected && <div className="mt-0.5 text-xs text-ink-2">Template: {styleSummary(parsed.style)}</div>}
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
            <div className="text-xs text-muted">PDF, DOCX or LaTeX (.tex) · up to {MAX_MB} MB</div>
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

export function styleSummary(st: DetectedStyle): string {
  const m = st.margins;
  const margins = m ? (new Set([m.top, m.bottom, m.left, m.right].map((x) => x.toFixed(2))).size === 1 ? `${m.left}″ margins` : `${m.left}″ side margins`) : "";
  return [st.font_family === "serif" ? "serif" : st.font_family === "sans" ? "sans-serif" : "", st.font_size ? `${st.font_size} pt` : "", st.page_size, margins]
    .filter(Boolean)
    .join(" · ");
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

const EDITABLE: Section[] = ["skills", "experience", "projects"];

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
  const order: Section[] = ["summary", ...EDITABLE];
  const set = (next: Section[]) => onSections(order.filter((x) => next.includes(x)));
  const toggle = (s: Section) => {
    const next = sections.includes(s) ? sections.filter((x) => x !== s) : [...sections, s];
    if (next.some((x) => x !== "summary")) set(next);
  };
  const editable = sections.filter((s) => s !== "summary");
  const wantsSummary = sections.includes("summary");
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 font-medium">Sections to edit</legend>
        <div className="flex flex-wrap gap-1.5">
          {EDITABLE.map((s) => {
            const on = sections.includes(s);
            const last = on && editable.length === 1;
            return (
              <button
                key={s}
                type="button"
                disabled={disabled || last}
                aria-pressed={on}
                onClick={() => toggle(s)}
                title={last ? "Keep at least one section selected" : undefined}
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
        <p className="mt-1 text-xs text-muted">Unselected sections stay word-for-word.</p>
      </fieldset>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-rule bg-paper px-3 py-2.5">
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--blue)]" checked={wantsSummary} disabled={disabled} onChange={() => toggle("summary")} />
        <span>
          <span className="block text-sm font-medium">Include a summary</span>
          <span className="block text-xs text-muted">Off by default. When on, a 2–3 line summary is written from your real experience.</span>
        </span>
      </label>

      <div>
        <div className="mb-1.5 font-medium" id="tone-label">
          Emphasis
        </div>
        <Segmented label="Emphasis" value={tone} options={TONES} onChange={onTone} disabled={disabled} />
        <p className="mt-1 text-xs text-muted">{TONES.find((t) => t.value === tone)?.hint}.</p>
      </div>

      <div>
        <label htmlFor="extra" className="mb-1.5 block font-medium">
          Instructions <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="extra"
          value={extra}
          disabled={disabled}
          maxLength={500}
          onChange={(e) => onExtra(e.target.value)}
          placeholder="e.g. Put backend work before frontend"
          className="h-10 w-full rounded-lg border border-rule bg-paper px-3 text-sm outline-none focus:border-blue disabled:opacity-60"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/** Optional extra material: another resume, project write-ups, role details.
 *  Used only as secondary evidence — never the primary resume. */
export function SupportingDocs({
  docs,
  onAdd,
  onRemove,
  onRename,
  onUpload,
  disabled,
}: {
  docs: SupportingDoc[];
  onAdd: (d: Omit<SupportingDoc, "id">) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onUpload: (f: File) => Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(docs.length > 0);
  const [pasting, setPasting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const full = docs.length >= MAX_DOCS;
  const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

  return (
    <div className="rounded-lg border border-rule bg-paper">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <FilePlus2 className="size-4 text-blue" aria-hidden />
        <span className="flex-1">
          <span className="block text-sm font-medium">
            Extra material <span className="font-normal text-muted">(optional)</span>
            {docs.length > 0 && <span className="ml-1.5 rounded-full bg-blue-wash px-1.5 py-px text-[11px] font-medium text-blue-ink">{docs.length}</span>}
          </span>
          <span className="block text-xs text-muted">Another resume, project notes, role details — used as background only.</span>
        </span>
        <ChevronDown className={cx("size-4 text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="space-y-2 border-t border-rule-soft px-3 pb-3 pt-2.5">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center gap-2 rounded-md bg-desk-2/60 px-2 py-1.5">
              <FileText className="size-4 shrink-0 text-muted" aria-hidden />
              <input
                value={d.label}
                onChange={(e) => onRename(d.id, e.target.value)}
                maxLength={80}
                disabled={disabled}
                aria-label="Document label"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none focus:underline"
              />
              <span className="shrink-0 text-xs tabular-nums text-muted">{d.word_count} words</span>
              <button type="button" onClick={() => onRemove(d.id)} disabled={disabled} className="rounded p-1 text-muted hover:text-red" aria-label={`Remove ${d.label}`}>
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          {pasting ? (
            <div className="space-y-1.5">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={80}
                placeholder="Label, e.g. QuickLink project notes"
                className="h-8 w-full rounded-md border border-rule bg-paper px-2 text-sm outline-none focus:border-blue"
              />
              <textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={20_000}
                placeholder="Paste project details, responsibilities, results…"
                className="scroll-thin block h-28 w-full resize-y rounded-md border border-rule bg-paper px-2 py-1.5 text-sm outline-none focus:border-blue"
              />
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setPasting(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={text.trim().length < 30}
                  onClick={() => {
                    onAdd({ label: label.trim() || "Notes", text: text.trim(), word_count: words(text) });
                    setText("");
                    setLabel("");
                    setPasting(false);
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
          ) : (
            !full && (
              <div className="flex gap-1.5">
                <Button size="sm" variant="secondary" loading={busy} disabled={disabled} onClick={() => input.current?.click()}>
                  <Upload className="size-3.5" /> Upload file
                </Button>
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setPasting(true)}>
                  <ClipboardPaste className="size-3.5" /> Paste text
                </Button>
              </div>
            )
          )}
          <p className="text-xs text-muted">
            {full ? `Up to ${MAX_DOCS} documents.` : "PDF, DOCX, LaTeX, TXT or Markdown."} Facts here can strengthen existing bullets and the summary; nothing is copied in as new experience.
          </p>
          <input
            ref={input}
            type="file"
            accept={DOC_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setBusy(true);
              try {
                await onUpload(f);
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
