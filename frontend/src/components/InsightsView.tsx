"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, CircleDashed, Loader2, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { exportCheck, type ExportOptions } from "@/lib/api";
import type { AtsResult, ConfirmedSkill, EditStats, ExportCheck, LayoutCheck, MatchResult, TailoredResume, TailorResult } from "@/lib/types";
import { Button, cx } from "./ui";

/** A ruler from 0–100 with a "before" tick and an "after" marker. */
export function ScoreRuler({ label, before, after, caption }: { label: string; before: number | null; after?: number | null; caption: string }) {
  const b = before ?? 0;
  const a = after ?? null;
  const delta = a !== null && before !== null ? a - b : null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium">{label}</h3>
        <div className="flex items-baseline gap-2 tabular-nums">
          {a !== null ? (
            <>
              <span className="text-sm text-muted line-through decoration-muted/60">{before ?? "—"}</span>
              <span className="text-3xl font-semibold tracking-tight">{a}</span>
              {delta !== null && delta !== 0 && <span className={cx("text-sm font-medium", delta > 0 ? "text-green" : "text-red")}>{delta > 0 ? `+${delta}` : delta}</span>}
            </>
          ) : (
            <span className="text-3xl font-semibold tracking-tight">{before ?? "—"}</span>
          )}
        </div>
      </div>
      <div className="relative mt-2 h-7" aria-hidden>
        <div className="absolute inset-x-0 top-3 h-1 rounded-full bg-desk-2" />
        <div className="absolute top-3 h-1 rounded-full bg-blue/80 transition-[width] duration-700" style={{ width: `${a ?? b}%` }} />
        {[0, 25, 50, 75, 100].map((t) => (
          <div key={t} className="absolute top-1.5 h-4 w-px bg-rule" style={{ left: `${t}%` }} />
        ))}
        {a !== null && <div className="absolute top-0.5 h-6 w-0.5 -translate-x-1/2 bg-ink-2/50" style={{ left: `${b}%` }} title={`Before: ${before}`} />}
        <div className="absolute top-1 size-5 -translate-x-1/2 rounded-full border-[3px] border-paper bg-blue shadow" style={{ left: `${a ?? b}%` }} />
      </div>
      <p className="mt-1 text-[13px] text-muted">{caption}</p>
    </div>
  );
}

const LOC_SHORT: Record<string, string> = { summary: "Sum", skills: "Skills", experience: "Exp", projects: "Proj" };

function KeywordChips({ match, re, locations }: { match: MatchResult; re?: boolean; locations?: Record<string, string[]> }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-[13px] text-muted">In your resume ({match.matched.length})</div>
        <div className="flex flex-wrap gap-1.5">
          {match.matched.map((k) => (
            <span
              key={k.keyword}
              className="rounded-sm px-1.5 py-0.5 text-[13px]"
              style={{ background: "var(--hl-soft)" }}
              title={[k.required ? "Required by the JD" : "", locations?.[k.keyword]?.length ? `Found in: ${locations[k.keyword].join(", ")}` : ""].filter(Boolean).join(" · ") || undefined}
            >
              {k.keyword}
              {k.required && <span className="ml-0.5 text-amber">*</span>}
              {locations?.[k.keyword]?.length ? <span className="ml-1 text-[11px] text-muted">{locations[k.keyword].map((l) => LOC_SHORT[l] ?? l).join("·")}</span> : null}
            </span>
          ))}
          {!match.matched.length && <span className="text-[13px] text-muted">None yet.</span>}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-[13px] text-muted">Not in your resume ({match.missing.length})</div>
        <div className="flex flex-wrap gap-1.5">
          {match.missing.map((k) => (
            <span key={k.keyword} className="rounded-sm border border-dashed border-rule px-1.5 py-0.5 text-[13px] text-ink-2">
              {k.keyword}
              {k.required && <span className="ml-0.5 text-amber">*</span>}
            </span>
          ))}
          {!match.missing.length && <span className="text-[13px] text-muted">Nothing missing — great coverage.</span>}
        </div>
      </div>
      {re !== false && <p className="text-xs text-muted">* required by the job post{locations ? " · small labels show where each keyword appears" : ""}.</p>}
    </div>
  );
}

function AtsChecks({ before, after }: { before: AtsResult; after?: AtsResult }) {
  const cur = after ?? before;
  const Icon = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle };
  const color = { pass: "text-green", warn: "text-amber", fail: "text-red" };
  return (
    <ul className="divide-y divide-rule-soft">
      {cur.checks.map((c) => {
        const prev = after ? before.checks.find((x) => x.id === c.id) : null;
        const I = Icon[c.status];
        return (
          <li key={c.id} className="flex gap-3 py-2.5">
            <I className={cx("mt-0.5 size-4 shrink-0", color[c.status])} aria-label={c.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{c.label}</span>
                <span className="shrink-0 text-[13px] tabular-nums text-muted">
                  {prev && prev.score !== c.score && <span className="mr-1 line-through">{Math.round(prev.score)}</span>}
                  {Math.round(c.score)}/{c.max}
                </span>
              </div>
              <p className="text-[13px] text-ink-2">{c.detail}</p>
              {c.tip && <p className="mt-0.5 text-[13px] text-muted">{c.tip}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function LayoutPanel({ checks, title = "How an ATS reads your file" }: { checks: LayoutCheck[]; title?: string }) {
  if (!checks?.length) return null;
  const Icon = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle };
  const color = { pass: "text-green", warn: "text-amber", fail: "text-red" };
  const problems = checks.filter((c) => c.status !== "pass").length;
  return (
    <Panel title={title} aside={<span className="text-[13px] text-muted">{problems ? `${problems} to fix` : "No layout problems"}</span>}>
      <p className="-mt-1 mb-2 text-[13.5px] text-ink-2">Checks the uploaded file itself — columns, tables, images, headers — the layout issues that make ATS parsers drop or scramble text.</p>
      <ul className="divide-y divide-rule-soft">
        {checks.map((c) => {
          const I = Icon[c.status];
          return (
            <li key={c.id} className="flex gap-3 py-2.5">
              <I className={cx("mt-0.5 size-4 shrink-0", color[c.status])} aria-label={c.status} />
              <div>
                <div className="font-medium">{c.label}</div>
                <p className="text-[13px] text-ink-2">{c.detail}</p>
                {c.tip && <p className="mt-0.5 text-[13px] text-muted">{c.tip}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function ReadBackPanel({ getResume, exportOpts }: { getResume: () => TailoredResume; exportOpts?: ExportOptions }) {
  const [res, setRes] = useState<ExportCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    exportCheck(getResume(), exportOpts)
      .then((r) => alive && setRes(r))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // Run once per mount; the tab remounts when the version changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ok = res && res.bullets_found === res.bullets_total && res.sections_found.length === res.sections_expected.length && res.contact_found;
  return (
    <Panel title="Your download, read back like an ATS">
      {!res && !error && (
        <p className="flex items-center gap-2 text-[13.5px] text-muted">
          <Loader2 className="size-4 animate-spin" /> Rendering the PDF and parsing it back…
        </p>
      )}
      {error && <p className="text-[13.5px] text-red">{error}</p>}
      {res && (
        <div className="flex gap-3">
          {ok ? <ShieldCheck className="mt-0.5 size-5 shrink-0 text-green" aria-hidden /> : <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber" aria-hidden />}
          <div className="space-y-1 text-[13.5px] text-ink-2">
            <p>
              Your PDF, parsed back:{" "}
              <b className="text-ink">
                {res.bullets_found}/{res.bullets_total} bullets
              </b>
              , <b className="text-ink">{res.sections_found.length}/{res.sections_expected.length} sections</b> and{" "}
              <b className="text-ink">{res.contact_found ? "your contact details" : "no contact details"}</b> recovered.
            </p>
            <p>
              {res.pages} page{res.pages > 1 ? "s" : ""}
              {res.pages > 2 ? " — trim to 1–2 pages." : " · single column · selectable text."}
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}

function Panel({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-rule-soft bg-paper p-4 sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-[17px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

interface ConfirmProps {
  confirmed?: ConfirmedSkill[];
  onConfirm?: (keyword: string, context: string) => void;
  onUnconfirm?: (keyword: string) => void;
}

function MissingItem({ m, confirmed, onConfirm, onUnconfirm }: { m: TailoredResume["missing_keywords"][number]; confirmed?: ConfirmedSkill } & Omit<ConfirmProps, "confirmed">) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  return (
    <li className="flex gap-3">
      <span
        className={cx(
          "mt-0.5 h-fit shrink-0 rounded-sm px-1.5 py-0.5 text-[11.5px] font-medium",
          m.importance === "high" ? "bg-red-wash text-red" : m.importance === "medium" ? "bg-amber-wash text-amber" : "bg-desk-2 text-muted",
        )}
      >
        {m.importance === "high" ? "Must-have" : m.importance === "medium" ? "Helpful" : "Bonus"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium">{m.keyword}</span>
          {onConfirm &&
            (confirmed ? (
              <span className="flex items-center gap-2 text-[12.5px]">
                <span className="inline-flex items-center gap-1 font-medium text-green">
                  <Check className="size-3.5" /> You have this
                </span>
                <button onClick={() => onUnconfirm?.(m.keyword)} className="text-muted underline-offset-2 hover:text-red hover:underline">
                  Undo
                </button>
              </span>
            ) : (
              !open && (
                <button onClick={() => setOpen(true)} className="text-[12.5px] font-medium text-blue underline-offset-2 hover:underline">
                  I have this
                </button>
              )
            ))}
        </div>
        {m.suggestion && <p className="text-[13.5px] text-ink-2">{m.suggestion}</p>}
        {confirmed?.context && <p className="mt-0.5 text-[13px] italic text-muted">“{confirmed.context}”</p>}
        {open && !confirmed && (
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onConfirm?.(m.keyword, note.trim());
              setOpen(false);
            }}
          >
            <input
              autoFocus
              value={note}
              maxLength={300}
              onChange={(e) => setNote(e.target.value)}
              placeholder={`Where did you use ${m.keyword}? (optional)`}
              aria-label={`Where you used ${m.keyword}`}
              className="h-9 min-w-0 flex-1 rounded-md border border-rule bg-paper px-2.5 text-sm outline-none focus:border-blue"
            />
            <Button size="sm" type="submit">
              Confirm
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </form>
        )}
      </div>
    </li>
  );
}

export function InsightsView({
  result,
  confirmed,
  onConfirm,
  onUnconfirm,
  onRegenerate,
  busy,
  layout,
  getResume,
  exportOpts,
}: { result: TailorResult; onRegenerate?: () => void; busy?: boolean; layout?: LayoutCheck[]; getResume?: () => TailoredResume; exportOpts?: ExportOptions } & ConfirmProps) {
  const { scores, resume: r, guardrails: g, meta } = result;
  const cur = scores.match.after ?? scores.match.before;
  const [which, setWhich] = useState<"after" | "before">("after");
  const match = (which === "after" ? scores.match.after : scores.match.before) ?? scores.match.before;
  return (
    <div className="mx-auto w-full max-w-[800px] space-y-4">
      <AtAGlance match={cur} before={scores.match.before} stats={result.stats} shown={scores.evidence?.shown.length} />
      <TopFixes ats={scores.ats.after ?? scores.ats.before} missingRequired={cur.missing.filter((k) => k.required).map((k) => k.keyword)} />

      <Panel title="Scores">
        <div className="grid gap-6 sm:grid-cols-2">
          <ScoreRuler
            label="Keyword match"
            before={scores.match.before.score}
            after={scores.match.after?.score}
            caption={
              scores.match.after?.note ??
              `${scores.match.before.total} job keywords, weighted by importance.`
            }
          />
          <ScoreRuler label="ATS readiness" before={scores.ats.before.score} after={scores.ats.after?.score} caption={`${(scores.ats.after ?? scores.ats.before).grade} · structure, contact, bullets, keywords.`} />
        </div>
        <p className="mt-4 text-[13px] text-muted">Computed by fixed rules, not the AI, so before and after are measured the same way.</p>
      </Panel>

      <Panel
        title="Keywords from the job"
        aside={
          scores.match.after && (
            <div className="flex rounded-lg bg-desk-2 p-0.5 text-[12.5px]" role="radiogroup" aria-label="Keyword view">
              {(["after", "before"] as const).map((w) => (
                <button key={w} role="radio" aria-checked={which === w} onClick={() => setWhich(w)} className={cx("rounded-md px-2 py-0.5", which === w ? "bg-paper font-medium shadow-sm" : "text-muted")}>
                  {w === "after" ? "Tailored" : "Original"}
                </button>
              ))}
            </div>
          )
        }
      >
        <KeywordChips match={match} locations={which === "after" ? scores.locations : undefined} />
      </Panel>

      {scores.evidence && (scores.evidence.listed_only.length > 0 || scores.evidence.shown.length > 0) && (
        <Panel title="Shown, not just listed">
          <p className="mb-3 text-[13.5px] text-ink-2">Highlighted: used in a bullet. Dashed: only in the Skills list.</p>
          <div className="flex flex-wrap gap-1.5">
            {scores.evidence.shown.map((k) => (
              <span key={k} className="rounded-sm px-1.5 py-0.5 text-[13px]" style={{ background: "var(--hl-soft)" }}>
                {k}
              </span>
            ))}
            {scores.evidence.listed_only.map((k) => (
              <span key={k} className="rounded-sm border border-dashed border-amber/60 px-1.5 py-0.5 text-[13px] text-amber" title="Only in the Skills list">
                {k}
              </span>
            ))}
          </div>
          {scores.evidence.listed_only.length > 0 && (
            <p className="mt-3 text-[13px] text-muted">
              If you&apos;ve used {scores.evidence.listed_only.slice(0, 3).join(", ")} in a project or role, mention it in that bullet.
            </p>
          )}
        </Panel>
      )}

      {r.missing_keywords.length > 0 && (
        <Panel title="Worth adding — if it's true">
          <p className="-mt-1 mb-3 text-[13.5px] text-ink-2">Never added automatically. Mark the ones you really have and the next version can use them.</p>
          <ul className="space-y-3">
            {r.missing_keywords.map((m) => (
              <MissingItem key={m.keyword} m={m} confirmed={confirmed?.find((c) => c.keyword.toLowerCase() === m.keyword.toLowerCase())} onConfirm={onConfirm} onUnconfirm={onUnconfirm} />
            ))}
          </ul>
          {onRegenerate && (confirmed?.length ?? 0) > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-rule-soft pt-4">
              <span className="text-[13.5px] text-ink-2">
                {confirmed!.length} confirmed skill{confirmed!.length > 1 ? "s" : ""}: {confirmed!.map((c) => c.keyword).join(", ")}
              </span>
              <Button size="sm" variant="primary" onClick={onRegenerate} disabled={busy}>
                <Sparkles className="size-3.5" /> Generate a version with them
              </Button>
            </div>
          )}
        </Panel>
      )}

      <Panel title="ATS checklist" aside={<span className="text-[13px] text-muted">for the tailored version</span>}>
        <AtsChecks before={scores.ats.before} after={scores.ats.after} />
      </Panel>

      {getResume && <ReadBackPanel getResume={getResume} exportOpts={exportOpts} />}

      {layout && layout.some((c) => c.status !== "pass") && <LayoutPanel checks={layout} title="Your original file's layout" />}

      <JDPanel r={r} />

      <Panel title="Truthfulness check">
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-green" aria-hidden />
          <div className="space-y-1 text-[13.5px] text-ink-2">
            <p>Every line was checked against your resume{g.supporting_used ? " and extra material" : ""} after the AI finished.</p>
            <p>
              {g.removed_skills.length
                ? `Removed ${g.removed_skills.length} skill${g.removed_skills.length > 1 ? "s" : ""} the AI added that your resume doesn't show: ${g.removed_skills.join(", ")}.`
                : "No unsupported skills were added."}
            </p>
            <p>
              {g.flagged_bullets
                ? `${g.flagged_bullets} line${g.flagged_bullets > 1 ? "s" : ""} ${g.copied_from_jd ? "mention something not in your original or copy wording from the job post" : "mention a number or tool that isn't in your original"} — they're marked "Check" on the resume. Keep them only if accurate.`
                : "No new numbers or tools were introduced."}
            </p>
            {(g.confirmed_used?.length ?? 0) > 0 && <p>Used skills you confirmed: {g.confirmed_used!.join(", ")}.</p>}
            {(g.removed_details?.length ?? 0) > 0 && <p>Removed details the AI added that aren&apos;t in your resume: {g.removed_details!.join("; ")}.</p>}
            {g.locked_sections.length > 0 && <p>Left untouched as requested: {g.locked_sections.join(", ")}.</p>}
          </div>
        </div>
      </Panel>

      <p className="pb-2 text-center text-xs text-muted">
        Generated with {meta.provider} · {meta.model} in {(meta.duration_ms / 1000).toFixed(1)}s
      </p>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" }) {
  return (
    <div className="min-w-0 rounded-lg border border-rule-soft bg-paper px-3 py-2.5">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={cx("text-xl font-semibold tabular-nums tracking-tight", tone === "good" && "text-green", tone === "warn" && "text-amber")}>{value}</div>
      {sub && <div className="truncate text-[12px] text-muted">{sub}</div>}
    </div>
  );
}

function AtAGlance({ match, before, stats, shown }: { match: MatchResult; before: MatchResult; stats?: EditStats; shown?: number }) {
  const req = `${match.required_matched ?? 0}/${match.required_total ?? 0}`;
  const opt = match.optional_total != null ? `${match.optional_matched ?? 0}/${match.optional_total}` : `${match.matched.length}/${match.total}`;
  const gained = (match.required_matched ?? 0) - (before.required_matched ?? 0);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Must-haves" value={req} sub={gained > 0 ? `+${gained} vs original` : "covered"} tone={match.required_total && match.required_matched === match.required_total ? "good" : undefined} />
      <Stat label={match.optional_total != null ? "Nice-to-haves" : "Keywords"} value={opt} sub="covered" />
      <Stat label="Shown in bullets" value={String(shown ?? "—")} sub="keywords with evidence" />
      {stats ? (
        <Stat label="Lines edited" value={`${stats.light + stats.rewritten + stats.new}/${stats.total}`} sub={`${stats.kept} kept · ${stats.light} light · ${stats.rewritten} rewritten`} />
      ) : (
        <Stat label="Keyword match" value={String(match.score ?? "—")} />
      )}
    </div>
  );
}

function TopFixes({ ats, missingRequired }: { ats: AtsResult; missingRequired: string[] }) {
  const fixes = ats.checks
    .filter((c) => c.tip && c.status !== "pass")
    .sort((a, b) => b.max - b.score - (a.max - a.score))
    .slice(0, 3)
    .map((c) => ({ id: c.id, text: c.tip!, gain: Math.round(c.max - c.score) }));
  if (!fixes.length && !missingRequired.length) return null;
  return (
    <Panel title="Next best fixes">
      <ol className="space-y-1.5 text-[13.5px]">
        {missingRequired.length > 0 && (
          <li className="flex gap-2">
            <span className="font-semibold text-red">1.</span>
            <span>
              Missing must-have{missingRequired.length > 1 ? "s" : ""}: <b>{missingRequired.slice(0, 5).join(", ")}</b>. If you have it, mark it below or ask the AI where to add it.
            </span>
          </li>
        )}
        {fixes.map((f, i) => (
          <li key={f.id} className="flex gap-2">
            <span className="font-semibold text-muted">{i + (missingRequired.length ? 2 : 1)}.</span>
            <span className="flex-1">{f.text}</span>
            {f.gain > 0 && <span className="shrink-0 text-[12px] tabular-nums text-muted">up to +{f.gain} ATS</span>}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function JDPanel({ r }: { r: TailoredResume }) {
  const a = r.jd_analysis;
  if (!a.role_title && !a.must_have.length) return null;
  return (
    <Panel title="What the job asks for">
      <p className="text-ink-2">
        <span className="font-medium text-ink">{a.role_title || "Role"}</span>
        {a.company && ` at ${a.company}`}
        {a.seniority && ` — ${a.seniority}`}
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {[
          ["Must-haves", a.must_have],
          ["Nice to have", a.nice_to_have],
        ].map(([title, list]) =>
          (list as string[]).length ? (
            <div key={title as string}>
              <div className="mb-1 text-[13px] text-muted">{title as string}</div>
              <ul className="space-y-1 text-[13.5px]">
                {(list as string[]).map((x) => (
                  <li key={x} className="flex gap-1.5">
                    <CircleDashed className="mt-1 size-3 shrink-0 text-muted" aria-hidden />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          ) : null,
        )}
      </div>
    </Panel>
  );
}

export function BaselineInsights({ match, ats, layout }: { match: MatchResult; ats: AtsResult; layout?: LayoutCheck[] }) {
  return (
    <div className="mx-auto w-full max-w-[800px] space-y-4">
      <Panel title="Your resume, before tailoring">
        <div className="grid gap-6 sm:grid-cols-2">
          <ScoreRuler
            label="Keyword match"
            before={match.score}
            caption={match.note ?? `${match.matched.length} of ${match.total} JD keywords found · ${match.required_matched ?? 0} of ${match.required_total ?? 0} must-haves.`}
          />
          <ScoreRuler label="ATS readiness" before={ats.score} caption={`${ats.grade}. Tailor to see how far this moves.`} />
        </div>
      </Panel>
      <Panel title="Keywords from the job">
        <KeywordChips match={match} />
      </Panel>
      {layout && <LayoutPanel checks={layout} />}
      <Panel title="ATS checklist">
        <AtsChecks before={ats} />
      </Panel>
    </div>
  );
}
