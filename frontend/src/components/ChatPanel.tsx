"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import type { ChatMessage, ChatProposal, LayoutSettings, Version } from "@/lib/types";
import { parseFlag, flagNote } from "@/lib/resume";
import { DiffText } from "./ChangesView";
import { cx } from "./ui";

const SUGGESTIONS = [
  "Make every bullet shorter and tighter",
  "Add a 2-line summary",
  "Set all margins to 0.5 inch",
  "Which must-haves am I still missing?",
  "Put my most relevant project first",
];

const LAYOUT_LABEL: Partial<Record<keyof LayoutSettings, string>> = {
  page_size: "Paper",
  font_family: "Font",
  font_size: "Body size",
  name_size: "Name size",
  heading_size: "Heading size",
  line_spacing: "Line spacing",
  heading_case: "Headings",
  heading_rule: "Heading line",
  header_align: "Header",
  accent: "Accent",
  show_summary: "Summary",
  one_page: "Fit to one page",
};

function fmt(v: unknown): string {
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v);
}

export function layoutChanges(cur: LayoutSettings, next: LayoutSettings): string[] {
  const out: string[] = [];
  const m0 = cur.margins;
  const m1 = next.margins;
  const sides = (["top", "bottom", "left", "right"] as const).filter((s) => m0[s] !== m1[s]);
  if (sides.length) out.push(`Margins: ${sides.map((s) => `${s} ${m0[s]}″ → ${m1[s]}″`).join(", ")}`);
  (Object.keys(LAYOUT_LABEL) as (keyof LayoutSettings)[]).forEach((k) => {
    if (cur[k] !== next[k]) out.push(`${LAYOUT_LABEL[k]}: ${fmt(cur[k])} → ${fmt(next[k])}`);
  });
  return out;
}

function ProposalCard({
  msg,
  proposal,
  version,
  layout,
  onApply,
  onDiscard,
  onUndo,
  canUndo,
}: {
  msg: ChatMessage;
  proposal: ChatProposal;
  version: Version;
  layout: LayoutSettings;
  onApply: () => void;
  onDiscard: () => void;
  onUndo: () => void;
  canUndo: boolean;
}) {
  const [all, setAll] = useState(false);
  const r = proposal.result;
  const before = version.result.scores.match.after?.score;
  const after = r?.scores.match.after?.score;
  const reqB = version.result.scores.match.after?.required_matched;
  const reqA = r?.scores.match.after?.required_matched;
  const layoutDiff = proposal.layout ? layoutChanges(msg.baseLayout ?? layout, proposal.layout) : [];
  const diff = proposal.diff ?? [];
  const shown = all ? diff : diff.slice(0, 4);
  const flags = r
    ? [...r.resume.experience, ...r.resume.projects].flatMap((it) => it.bullets.filter((b) => b.flags?.length && diff.some((d) => d.after === (b.tailored || b.original))).flatMap((b) => b.flags.map((f) => flagNote(parseFlag(f)))))
    : [];
  const status = msg.status ?? "pending";

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-rule bg-paper">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule-soft bg-desk/50 px-3 py-2 text-[12.5px]">
        <span className="font-medium text-ink">Proposed change</span>
        <span className="text-muted">
          {diff.length ? `${diff.length} line${diff.length > 1 ? "s" : ""}` : ""}
          {diff.length && layoutDiff.length ? " · " : ""}
          {layoutDiff.length ? `${layoutDiff.length} page setting${layoutDiff.length > 1 ? "s" : ""}` : ""}
        </span>
        {after != null && before != null && (
          <span className={cx("tabular-nums", after > before ? "text-green" : after < before ? "text-red" : "text-muted")}>
            match {before} → {after}
            {reqA != null && reqB != null && reqA !== reqB ? ` · must-haves ${reqB} → ${reqA}` : ""}
          </span>
        )}
      </div>
      <div className="max-h-[360px] space-y-2 overflow-y-auto px-3 py-2.5 scroll-thin">
        {shown.map((d) => (
          <div key={d.path}>
            <div className="mb-0.5 text-[11.5px] font-medium text-muted">{d.label}</div>
            <p className="paper-text rounded-md bg-desk/50 px-2 py-1.5 !text-[13px] !leading-snug">
              {d.before || d.after ? <DiffText before={d.before} after={d.after} /> : null}
              {!d.after && <em className="font-sans text-[11.5px] text-muted"> (removed)</em>}
            </p>
          </div>
        ))}
        {diff.length > 4 && (
          <button onClick={() => setAll((a) => !a)} className="text-[12px] font-medium text-blue hover:underline">
            {all ? "Show fewer" : `Show all ${diff.length}`}
          </button>
        )}
        {layoutDiff.length > 0 && (
          <ul className="space-y-0.5 text-[12.5px] text-ink-2">
            {layoutDiff.map((l) => (
              <li key={l}>• {l}</li>
            ))}
          </ul>
        )}
        {flags.length > 0 && <p className="rounded bg-red-wash px-2 py-1 text-[12px] text-red">Check before applying: {Array.from(new Set(flags)).join("; ")}.</p>}
      </div>
      <div className="flex items-center gap-2 border-t border-rule-soft px-3 py-2">
        {status === "pending" ? (
          <>
            <button onClick={onApply} className="inline-flex items-center gap-1 rounded-md bg-blue px-2.5 py-1 text-[13px] font-medium text-white hover:bg-blue-ink">
              <Check className="size-3.5" /> Apply
            </button>
            <button onClick={onDiscard} className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[13px] text-ink-2 hover:bg-desk-2">
              <X className="size-3.5" /> Discard
            </button>
            <span className="ml-auto text-[11.5px] text-muted">Nothing changes until you apply.</span>
          </>
        ) : status === "applied" ? (
          <>
            <span className="inline-flex items-center gap-1 text-[13px] font-medium text-green">
              <Check className="size-3.5" /> Applied
            </span>
            {canUndo && (
              <button onClick={onUndo} className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] text-ink-2 hover:bg-desk-2">
                <RotateCcw className="size-3.5" /> Undo
              </button>
            )}
          </>
        ) : (
          <span className="text-[13px] text-muted">Discarded</span>
        )}
      </div>
    </div>
  );
}

export function ChatPanel({
  version,
  layout,
  messages,
  busy,
  onSend,
  onApply,
  onDiscard,
  onUndo,
  undoId,
  onClear,
}: {
  version: Version | null;
  layout: LayoutSettings;
  messages: ChatMessage[];
  busy: boolean;
  onSend: (text: string) => void;
  onApply: (id: string) => void;
  onDiscard: (id: string) => void;
  onUndo: (id: string) => void;
  /** Only the most recent applied proposal can be undone. */
  undoId: string | null;
  onClear: () => void;
}) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, busy]);

  const send = (t: string) => {
    const v = t.trim();
    if (!v || busy || !version) return;
    onSend(v);
    setText("");
  };

  if (!version) {
    return (
      <div className="rounded-lg border border-dashed border-rule px-4 py-8 text-center text-sm text-muted">
        <Sparkles className="mx-auto mb-2 size-5 text-blue" />
        Tailor your resume first. Then ask the AI for any change — wording, order, summary, margins, fonts — and approve it before it&apos;s applied.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[420px] flex-col">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[12.5px] text-muted">Editing: {version.label}</p>
        {messages.length > 0 && (
          <button onClick={onClear} className="text-[12px] text-muted hover:text-ink">
            Clear chat
          </button>
        )}
      </div>
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto pr-1 scroll-thin" aria-live="polite">
        {!messages.length && (
          <div className="space-y-2">
            <p className="text-[13.5px] text-ink-2">Ask for any change. You&apos;ll see a before/after and decide whether to apply it. Facts are still checked against your resume.</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-rule bg-paper px-2.5 py-1 text-left text-[12.5px] text-ink-2 hover:border-blue hover:text-blue">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="ml-8 rounded-lg rounded-br-sm bg-blue px-3 py-2 text-[13.5px] text-white">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="mr-2">
              <div className={cx("rounded-lg rounded-bl-sm px-3 py-2 text-[13.5px]", m.error ? "bg-red-wash text-red" : "bg-paper text-ink shadow-sm")}>
                <p className="whitespace-pre-wrap">{m.content}</p>
                {m.changes && m.changes.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-ink-2">
                    {m.changes.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                )}
              </div>
              {m.proposal && (
                <ProposalCard
                  msg={m}
                  proposal={m.proposal}
                  version={version}
                  layout={layout}
                  onApply={() => onApply(m.id)}
                  onDiscard={() => onDiscard(m.id)}
                  onUndo={() => onUndo(m.id)}
                  canUndo={undoId === m.id}
                />
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <Loader2 className="size-4 animate-spin" /> Thinking…
          </div>
        )}
      </div>
      <form
        className="mt-3 flex items-end gap-2 rounded-lg border border-rule bg-paper p-1.5 focus-within:border-blue"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          rows={2}
          maxLength={1500}
          placeholder="e.g. Shorten the Acme bullets and use 0.5″ side margins"
          aria-label="Message the AI editor"
          className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent px-1.5 py-1 text-[13.5px] outline-none"
        />
        <button type="submit" disabled={busy || !text.trim()} className="grid size-8 shrink-0 place-items-center rounded-md bg-blue text-white disabled:opacity-40" aria-label="Send">
          <ArrowUp className="size-4" />
        </button>
      </form>
    </div>
  );
}
