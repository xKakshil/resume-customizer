"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, LogOut, PencilLine, Plus, Sparkles, Square, Highlighter, X, RotateCw, AlertTriangle } from "lucide-react";
import { ApiError, cleanJD, fetchJD, health, history as historyApi, parseResume, scoreResume, setAuthToken, tailorStream, auth } from "@/lib/api";
import type { ConfirmedSkill, ParsedResume, Scores, Section, TailoredResume, Tone, User, Version } from "@/lib/types";
import { ALL_SECTIONS } from "@/lib/types";
import { effectiveResume, timeAgo } from "@/lib/resume";
import { parsePartialResume } from "@/lib/partial";
import { KEYS, load, save } from "@/lib/storage";
import { SAMPLE_JD, SAMPLE_RESUME_URL } from "@/lib/sample";
import { JDInput, MAX_JD, MIN_JD, Options, ResumeUpload, TONES, validateFile } from "./InputPanel";
import { OriginalPaper, ResumePaper } from "./ResumePaper";
import { ChangesView } from "./ChangesView";
import { BaselineInsights, InsightsView } from "./InsightsView";
import { CoverLetterView } from "./CoverLetterView";
import { CompareView } from "./CompareView";
import { DownloadMenu } from "./DownloadMenu";
import { AuthDialog, HistoryDrawer } from "./AccountUI";
import { useTermsRegex } from "./highlight";
import { Button, cx, useToast } from "./ui";

type Tab = "resume" | "changes" | "insights" | "cover" | "compare";
const MAX_VERSIONS = 6;
const STAGES: Record<string, string> = {
  connecting: "Sending to the editor",
  analyzing: "Reading the job description",
  writing: "Rewriting your resume",
  validating: "Checking facts and scoring",
  repairing: "Tidying an incomplete response",
};

interface RunState {
  status: "idle" | "streaming" | "error";
  stage: string;
  raw: string;
  error: string | null;
  errorCode?: string;
}

export function Workbench() {
  const toast = useToast();
  // --- inputs ---------------------------------------------------------------
  const [jd, setJd] = useState("");
  const [jdTouched, setJdTouched] = useState(false);
  const [jdClean, setJdClean] = useState<{ removed: number; previous: string } | null>(null);
  const jdRef = useRef("");
  useEffect(() => {
    jdRef.current = jd;
  }, [jd]);
  const [parsed, setParsed] = useState<ParsedResume | null>(null);
  const [upload, setUpload] = useState<{ busy: boolean; progress: number; error: string | null; file: { name: string; size: number } | null }>({ busy: false, progress: 0, error: null, file: null });
  const [sections, setSections] = useState<Section[]>(ALL_SECTIONS);
  const [tone, setTone] = useState<Tone>("balanced");
  const [extra, setExtra] = useState("");
  const [confirmed, setConfirmed] = useState<ConfirmedSkill[]>([]);
  const [scored, setBaseline] = useState<Scores | null>(null);

  const baselineReady = jd.trim().length >= MIN_JD && jd.trim().length <= MAX_JD && !!parsed;
  const baseline = baselineReady ? scored : null;

  // --- results --------------------------------------------------------------
  const [run, setRun] = useState<RunState>({ status: "idle", stage: "", raw: "", error: null });
  const [versions, setVersions] = useState<Version[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("resume");
  const [preTab, setPreTab] = useState<"resume" | "insights">("resume");
  const [editing, setEditing] = useState(false);
  const [highlightOn, setHighlightOn] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // --- account / server -----------------------------------------------------
  const [user, setUser] = useState<User | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [server, setServer] = useState<"checking" | "waking" | "ok" | "down" | "no_llm">("checking");
  const [hydrated, setHydrated] = useState(false);

  // Restore session ------------------------------------------------------------
  // localStorage is only readable after hydration, so restoring in a mount effect
  // (rather than lazy state) avoids server/client markup mismatches.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setJd(load(KEYS.jd, ""));
    setParsed(load<ParsedResume | null>(KEYS.resume, null));
    const opts = load<{ sections?: Section[]; tone?: Tone; extra?: string }>(KEYS.options, {});
    if (opts.sections?.length) setSections(opts.sections);
    if (opts.tone) setTone(opts.tone);
    if (opts.extra) setExtra(opts.extra);
    setConfirmed(load<ConfirmedSkill[]>(KEYS.confirmed, []));
    const vs = load<Version[]>(KEYS.versions, []);
    if (vs.length) {
      setVersions(vs);
      setActiveKey(vs[vs.length - 1].key);
    }
    const a = load<{ token: string; user: User } | null>(KEYS.auth, null);
    if (a?.token) {
      setAuthToken(a.token);
      setUser(a.user);
      auth.me().then(setUser).catch((e: ApiError) => {
        if (e.status === 401) {
          setAuthToken(null);
          setUser(null);
          save(KEYS.auth, null);
        }
      });
    }
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => save(KEYS.jd, jd), 300);
    return () => clearTimeout(t);
  }, [jd, hydrated]);
  useEffect(() => void (hydrated && save(KEYS.resume, parsed)), [parsed, hydrated]);
  useEffect(() => void (hydrated && save(KEYS.options, { sections, tone, extra })), [sections, tone, extra, hydrated]);
  useEffect(() => void (hydrated && save(KEYS.versions, versions)), [versions, hydrated]);
  useEffect(() => void (hydrated && save(KEYS.confirmed, confirmed)), [confirmed, hydrated]);

  // Wake the server (free hosting sleeps when idle) ---------------------------
  useEffect(() => {
    let cancelled = false;
    const slow = setTimeout(() => !cancelled && setServer((s) => (s === "checking" ? "waking" : s)), 2500);
    (async () => {
      const deadline = Date.now() + 100_000;
      while (!cancelled && Date.now() < deadline) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 20_000);
          const h = await health(ctrl.signal);
          clearTimeout(t);
          if (!cancelled) setServer(h.llm.length ? "ok" : "no_llm");
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (!cancelled) setServer("down");
    })();
    return () => {
      cancelled = true;
      clearTimeout(slow);
    };
  }, []);

  // Baseline score as soon as both inputs are valid (cheap, no LLM) ----------
  const jdLen = jd.trim().length;
  const jdValid = jdLen >= MIN_JD && jdLen <= MAX_JD;
  useEffect(() => {
    if (!jdValid || !parsed) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      scoreResume(jd, parsed.text, ctrl.signal).then(setBaseline).catch(() => setBaseline(null));
    }, 600);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [jd, parsed, jdValid]);

  // --- handlers ---------------------------------------------------------------
  const handleFile = useCallback(async (file: File) => {
    const err = validateFile(file);
    if (err) {
      setUpload({ busy: false, progress: 0, error: err, file: null });
      return;
    }
    setUpload({ busy: true, progress: 0, error: null, file: { name: file.name, size: file.size } });
    try {
      const p = await parseResume(file, (progress) => setUpload((u) => ({ ...u, progress })));
      setParsed(p);
      setUpload({ busy: false, progress: 100, error: null, file: null });
      setPreTab("resume");
    } catch (e) {
      setUpload({ busy: false, progress: 0, error: (e as ApiError).message, file: null });
    }
  }, []);

  // Strip "Apply now", EEO statements, "Posted 3 days ago"… right after a paste, with undo.
  const onJdPasted = async () => {
    // Read straight from the textarea: state may not have flushed yet right after the paste.
    const before = (document.getElementById("jd") as HTMLTextAreaElement | null)?.value ?? jdRef.current;
    try {
      const res = await cleanJD(before);
      if (res.removed_lines > 0 && jdRef.current === before) {
        setJd(res.job_description);
        setJdClean({ removed: res.removed_lines, previous: before });
      }
    } catch {
      /* cleaning is a nicety; the server also cleans before tailoring */
    }
  };

  const importJD = async (url: string): Promise<boolean> => {
    try {
      const res = await fetchJD(url);
      setJd(res.job_description);
      setJdClean(null);
      setJdTouched(false);
      toast("success", `Imported ${res.title ? `"${[res.title, res.company].filter(Boolean).join(" — ")}"` : "the job description"}. Check it reads correctly.`);
      return true;
    } catch (e) {
      toast("error", (e as Error).message);
      return false;
    }
  };

  const confirmSkill = (keyword: string, context: string) =>
    setConfirmed((cs) => [...cs.filter((c) => c.keyword.toLowerCase() !== keyword.toLowerCase()), { keyword, context }].slice(-20));
  const unconfirmSkill = (keyword: string) => setConfirmed((cs) => cs.filter((c) => c.keyword.toLowerCase() !== keyword.toLowerCase()));

  const loadSample = async () => {
    setJd(SAMPLE_JD);
    setJdTouched(false);
    try {
      const blob = await (await fetch(SAMPLE_RESUME_URL)).blob();
      await handleFile(new File([blob], "sample-resume.pdf", { type: "application/pdf" }));
    } catch {
      toast("error", "Couldn't load the sample resume.");
    }
  };

  const active = versions.find((v) => v.key === activeKey) ?? null;
  const streaming = run.status === "streaming";

  const tailor = async () => {
    setJdTouched(true);
    if (!jdValid) {
      document.getElementById("jd")?.focus();
      return;
    }
    if (!parsed) {
      toast("info", "Upload your resume first.");
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setEditing(false);
    setRun({ status: "streaming", stage: "connecting", raw: "", error: null });
    setTab("resume");
    if (window.innerWidth < 1024) setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);

    let raw = "";
    let lastPaint = 0;
    try {
      const result = await tailorStream(
        {
          job_description: jd,
          resume_text: parsed.text,
          sections,
          tone,
          extra_instructions: extra,
          resume_filename: parsed.filename,
          confirmed_skills: confirmed,
        },
        {
          onStatus: (s) => setRun((r) => ({ ...r, stage: s.stage })),
          onDelta: (d) => {
            raw += d;
            const now = performance.now();
            if (now - lastPaint > 80) {
              lastPaint = now;
              setRun((r) => ({ ...r, raw }));
            }
          },
        },
        ctrl.signal,
      );
      const n = versions.length ? Math.max(...versions.map((v) => Number(v.key.split("-")[1]) || 0)) + 1 : 1;
      const v: Version = {
        key: `v-${n}`,
        label: `Version ${n} · ${TONES.find((t) => t.value === tone)?.label ?? tone}`,
        result,
        rejected: {},
        edits: {},
      };
      setVersions((vs) => [...vs, v].slice(-MAX_VERSIONS));
      setActiveKey(v.key);
      setRun({ status: "idle", stage: "", raw: "", error: null });
      const after = result.scores.match.after?.score;
      const before = result.scores.match.before.score;
      toast("success", after != null && before != null ? `Done — keyword match ${before} → ${after}.` : "Your tailored resume is ready.");
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "aborted") {
        setRun({ status: "idle", stage: "", raw: "", error: null });
        toast("info", "Stopped.");
      } else {
        setRun({ status: "error", stage: "", raw: "", error: err.message, errorCode: err.code });
      }
    }
  };

  const stop = () => abortRef.current?.abort();

  const updateActive = (fn: (v: Version) => Version) => setVersions((vs) => vs.map((v) => (v.key === activeKey ? fn(v) : v)));
  const toggleDecision = (path: string) =>
    updateActive((v) => {
      const edits = { ...v.edits };
      if (edits[path] !== undefined) {
        delete edits[path];
        return { ...v, edits };
      }
      return { ...v, rejected: { ...v.rejected, [path]: !v.rejected[path] } };
    });
  const revertAll = (rejectAll: boolean) =>
    updateActive((v) => {
      if (!rejectAll) return { ...v, rejected: {}, edits: {} };
      const rejected: Record<string, boolean> = { summary: true };
      (["experience", "projects"] as const).forEach((k) => v.result.resume[k].forEach((it, i) => it.bullets.forEach((_, j) => (rejected[`${k}.${i}.${j}`] = true))));
      return { ...v, rejected, edits: {} };
    });
  const editUnit = (path: string, text: string) => updateActive((v) => ({ ...v, edits: { ...v.edits, [path]: text } }));

  const removeVersion = (key: string) => {
    setVersions((vs) => {
      const next = vs.filter((v) => v.key !== key);
      if (key === activeKey) setActiveKey(next.length ? next[next.length - 1].key : null);
      if (next.length < 2 && tab === "compare") setTab("resume");
      return next;
    });
  };

  const onAuthed = (token: string, u: User) => {
    setAuthToken(token);
    setUser(u);
    save(KEYS.auth, { token, user: u });
    toast("success", `Signed in as ${u.email}. New results are saved to your history.`);
  };
  const signOut = () => {
    setAuthToken(null);
    setUser(null);
    save(KEYS.auth, null);
    toast("info", "Signed out.");
  };

  const openRun = async (id: number) => {
    try {
      const r = await historyApi.get(id);
      setJd(r.job_description);
      setParsed((p) =>
        p?.text === r.resume_text
          ? p
          : { text: r.resume_text, filename: r.resume_filename || "Saved resume", file_type: "pdf", size_bytes: 0, pages: null, word_count: r.resume_text.split(/\s+/).length, char_count: r.resume_text.length, links: [], sections: [], warnings: [] },
      );
      const key = `h-${id}`;
      const v: Version = { key, label: `Saved · ${r.result.resume.jd_analysis.role_title || "resume"} · ${timeAgo(r.created_at)}`, result: r.result, rejected: {}, edits: {} };
      setVersions((vs) => [...vs.filter((x) => x.key !== key), v].slice(-MAX_VERSIONS));
      setActiveKey(key);
      setTab("resume");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  // Highlighting: JD keywords present in what's on the page.
  const hlTerms = useMemo(() => {
    if (!highlightOn) return [];
    if (active) return (active.result.scores.match.after ?? active.result.scores.match.before).matched.map((k) => k.keyword).concat(active.result.resume.skills.matched);
    return baseline?.match.before.matched.map((k) => k.keyword) ?? [];
  }, [active, baseline, highlightOn]);
  const re = useTermsRegex(hlTerms);

  const partial = useMemo(() => (streaming ? parsePartialResume(run.raw) : null), [streaming, run.raw]);
  const getEffective = useCallback((): TailoredResume => effectiveResume(active!), [active]);

  // --- render -------------------------------------------------------------------
  return (
    <div className="flex min-h-screen flex-col">
      <header className="no-print sticky top-0 z-40 border-b border-rule-soft bg-desk/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="mr-auto flex items-center gap-2 text-[19px] font-bold tracking-tight">
            <span className="relative">
              <span className="absolute inset-x-[-3px] -bottom-[1px] h-[6px] -skew-x-6 rounded-sm bg-hl" aria-hidden />
              <span className="relative">Tailor</span>
            </span>
          </Link>
          <ServerBadge state={server} />
          {user ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
                <History className="size-4" /> <span className="hidden sm:inline">History</span>
              </Button>
              <Button variant="ghost" size="sm" onClick={signOut} title={`Signed in as ${user.email}`}>
                <LogOut className="size-4" /> <span className="hidden sm:inline">Sign out</span>
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setAuthOpen(true)}>
              Sign in
            </Button>
          )}
        </div>
      </header>

      {server === "waking" && (
        <div className="no-print border-b border-rule-soft bg-amber-wash px-4 py-2 text-center text-[13px] text-amber" role="status">
          Waking up the server — free hosting sleeps when idle, so the first request can take up to a minute.
        </div>
      )}
      {server === "down" && (
        <div className="no-print border-b border-rule-soft bg-red-wash px-4 py-2 text-center text-[13px] text-red" role="alert">
          The server isn&apos;t responding right now. Please refresh in a minute.
        </div>
      )}
      {server === "no_llm" && (
        <div className="no-print border-b border-rule-soft bg-red-wash px-4 py-2 text-center text-[13px] text-red" role="alert">
          The server has no AI provider configured, so tailoring is unavailable. Parsing and scoring still work.
        </div>
      )}

      <main className="mx-auto grid w-full max-w-[1500px] flex-1 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[400px_minmax(0,1fr)] lg:gap-8">
        {/* ---------------- Left rail: inputs ---------------- */}
        <aside className="no-print lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-1 scroll-thin">
          <h1 className="text-[26px] font-bold leading-[1.15] tracking-tight">Fit your resume to the job.</h1>
          <p className="mt-1.5 text-ink-2">Paste a posting, add your resume, and get an honest rewrite you can review line by line and download.</p>
          {!parsed && !jd && (
            <button onClick={loadSample} className="mt-2 text-sm font-medium text-blue underline-offset-2 hover:underline">
              Try it with a sample resume and job
            </button>
          )}

          <div className="mt-6 space-y-5">
            <JDInput
              value={jd}
              onChange={(v) => {
                setJd(v);
                setJdClean(null);
              }}
              disabled={streaming}
              onSubmit={tailor}
              touched={jdTouched}
              onPasted={onJdPasted}
              cleanedLines={jdClean?.removed}
              onUndoClean={() => {
                if (jdClean) setJd(jdClean.previous);
                setJdClean(null);
              }}
              onImport={importJD}
            />
            <ResumeUpload
              parsed={parsed}
              uploading={upload.busy}
              progress={upload.progress}
              error={upload.error}
              pendingFile={upload.file}
              onFile={handleFile}
              onClear={() => {
                setParsed(null);
                setBaseline(null);
              }}
              disabled={streaming}
            />
            <Options sections={sections} tone={tone} extra={extra} onSections={setSections} onTone={setTone} onExtra={setExtra} disabled={streaming} />

            {confirmed.length > 0 && (
              <div>
                <div className="mb-1.5 font-medium">Skills you confirmed</div>
                <div className="flex flex-wrap gap-1.5">
                  {confirmed.map((c) => (
                    <span key={c.keyword} className="inline-flex items-center gap-1 rounded-full border border-green/40 bg-green-wash py-0.5 pl-2.5 pr-1 text-[13px] text-green" title={c.context || undefined}>
                      {c.keyword}
                      <button onClick={() => unconfirmSkill(c.keyword)} disabled={streaming} className="rounded-full p-0.5 hover:bg-green/15" aria-label={`Remove ${c.keyword}`}>
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted">Not in your resume, but you said you have them — the next version can use them.</p>
              </div>
            )}

            <div className="sticky bottom-0 -mx-1 bg-desk px-1 pb-1 pt-2 lg:static">
              {streaming ? (
                <Button size="lg" className="w-full" onClick={stop}>
                  <Square className="size-4" /> Stop
                </Button>
              ) : (
                <Button size="lg" variant="primary" className="w-full" onClick={tailor} disabled={upload.busy}>
                  {versions.length ? <Plus className="size-4" /> : <Sparkles className="size-4" />}
                  {versions.length ? "Generate another version" : "Tailor my resume"}
                </Button>
              )}
              {!parsed && jdValid && <p className="mt-1.5 text-center text-xs text-muted">Upload your resume to continue.</p>}
            </div>
          </div>
        </aside>

        {/* ---------------- Right: the desk ---------------- */}
        <section ref={resultsRef} className="min-w-0 scroll-mt-20" aria-live="polite">
          {run.status === "error" && (
            <div role="alert" className="no-print mx-auto mb-4 flex max-w-[800px] items-start gap-3 rounded-lg border border-red/30 bg-red-wash p-4 text-red">
              <AlertTriangle className="mt-0.5 size-5 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">Couldn&apos;t tailor your resume</p>
                <p className="text-sm">{run.error}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                {!["jd_too_short", "jd_too_long", "not_a_jd", "jd_empty", "resume_empty", "resume_too_short"].includes(run.errorCode ?? "") && (
                  <Button size="sm" onClick={tailor}>
                    <RotateCw className="size-3.5" /> Try again
                  </Button>
                )}
                <button onClick={() => setRun({ status: "idle", stage: "", raw: "", error: null })} className="rounded-md p-1.5 hover:bg-red/10" aria-label="Dismiss">
                  <X className="size-4" />
                </button>
              </div>
            </div>
          )}

          {streaming ? (
            <div>
              <StageBar stage={run.stage} chars={run.raw.length} />
              {partial && (partial.candidate.name || partial.summary.tailored) ? (
                <ResumePaper resume={partial} version={null} re={null} streaming />
              ) : (
                <WritingPlaceholder />
              )}
            </div>
          ) : active ? (
            <div>
              <VersionStrip versions={versions} activeKey={active.key} onPick={setActiveKey} onRemove={removeVersion} />
              <div className="no-print mx-auto mb-4 flex max-w-[800px] flex-wrap items-center gap-2">
                <nav className="flex flex-wrap rounded-lg bg-desk-2 p-1" aria-label="Result views">
                  {(
                    [
                      ["resume", "Resume"],
                      ["changes", "Changes"],
                      ["insights", "Insights"],
                      ["cover", "Cover letter"],
                      ["compare", "Compare"],
                    ] as [Tab, string][]
                  ).map(([t, label]) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      aria-current={tab === t ? "page" : undefined}
                      className={cx("rounded-md px-3 py-1.5 text-[13.5px] transition-colors", tab === t ? "bg-paper font-medium shadow-sm" : "text-muted hover:text-ink")}
                    >
                      {label}
                      {t === "insights" && active.result.scores.match.after?.score != null && <span className="ml-1.5 tabular-nums text-blue">{active.result.scores.match.after.score}</span>}
                      {t === "compare" && versions.length > 1 && <span className="ml-1.5 text-muted">{versions.length}</span>}
                    </button>
                  ))}
                </nav>
                <span className="flex-1" />
                {tab === "resume" && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setHighlightOn((h) => !h)} aria-pressed={highlightOn} title="Highlight job keywords">
                      <Highlighter className={cx("size-4", highlightOn && "text-amber")} />
                      <span className="sr-only">Highlight keywords</span>
                    </Button>
                    <Button variant={editing ? "primary" : "ghost"} size="sm" onClick={() => setEditing((e) => !e)} aria-pressed={editing}>
                      <PencilLine className="size-4" /> {editing ? "Done editing" : "Edit"}
                    </Button>
                  </>
                )}
                <DownloadMenu getResume={getEffective} />
              </div>

              {tab === "resume" && (
                <>
                  {editing && <p className="no-print mx-auto mb-2 max-w-[800px] text-center text-[13px] text-muted">Click any line to edit it. Your edits are used in every download.</p>}
                  <ResumePaper resume={active.result.resume} version={active} re={re} editable={editing} onEdit={editUnit} />
                </>
              )}
              {tab === "changes" && <ChangesView version={active} resumeText={parsed?.text ?? ""} onToggle={toggleDecision} onRevertAll={revertAll} />}
              {tab === "insights" && (
                <InsightsView
                  result={active.result}
                  confirmed={confirmed}
                  onConfirm={confirmSkill}
                  onUnconfirm={unconfirmSkill}
                  onRegenerate={tailor}
                  busy={streaming}
                />
              )}
              {tab === "cover" && (
                <CoverLetterView
                  key={active.key}
                  jd={jd}
                  resumeText={active.result.tailored_text || parsed?.text || ""}
                  candidateName={active.result.resume.candidate.name}
                  defaultCompany={active.result.resume.jd_analysis.company}
                  initial={active.result.cover_letter}
                  runId={active.result.id}
                  signedIn={!!user}
                  onChange={(text) => updateActive((v) => ({ ...v, result: { ...v.result, cover_letter: text } }))}
                />
              )}
              {tab === "compare" && <CompareView versions={versions} activeKey={active.key} />}
            </div>
          ) : parsed ? (
            <div>
              <div className="no-print mx-auto mb-4 flex max-w-[800px] flex-wrap items-center gap-2">
                <nav className="flex rounded-lg bg-desk-2 p-1" aria-label="Preview views">
                  {(
                    [
                      ["resume", "Your resume as read"],
                      ["insights", baseline ? `Fit check · ${baseline.match.before.score ?? "—"}` : "Fit check"],
                    ] as ["resume" | "insights", string][]
                  ).map(([t, label]) => (
                    <button key={t} onClick={() => setPreTab(t)} disabled={t === "insights" && !baseline} className={cx("rounded-md px-3 py-1.5 text-[13.5px] disabled:opacity-50", preTab === t ? "bg-paper font-medium shadow-sm" : "text-muted hover:text-ink")}>
                      {label}
                    </button>
                  ))}
                </nav>
                <p className="text-[13px] text-muted">{baseline ? "Highlighted words already match the job." : "Paste the job description to see how well this fits."}</p>
              </div>
              {preTab === "insights" && baseline ? <BaselineInsights match={baseline.match.before} ats={baseline.ats.before} /> : <OriginalPaper text={parsed.text} re={re} />}
            </div>
          ) : (
            <EmptyDesk />
          )}
        </section>
      </main>

      <footer className="no-print border-t border-rule-soft px-4 py-4 text-center text-xs text-muted">
        Tailor never invents experience: skills you don&apos;t have are suggested, not added. Your files are processed in memory and not stored unless you sign in.
      </footer>

      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} onAuthed={onAuthed} />
      {historyOpen && <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} onOpenRun={openRun} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function ServerBadge({ state }: { state: string }) {
  const map: Record<string, [string, string]> = {
    checking: ["bg-rule", "Connecting"],
    waking: ["bg-amber animate-pulse", "Waking server"],
    ok: ["bg-green", "Ready"],
    down: ["bg-red", "Offline"],
    no_llm: ["bg-red", "AI unavailable"],
  };
  const [color, label] = map[state] ?? map.checking;
  return (
    <span className="hidden items-center gap-1.5 text-xs text-muted sm:flex" title={`Server: ${label}`}>
      <span className={cx("size-2 rounded-full", color)} aria-hidden />
      {label}
    </span>
  );
}

function StageBar({ stage, chars }: { stage: string; chars: number }) {
  const order = ["connecting", "analyzing", "writing", "validating"];
  const idx = Math.max(0, order.indexOf(stage === "repairing" ? "validating" : stage));
  return (
    <div className="no-print mx-auto mb-4 max-w-[800px]">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{STAGES[stage] ?? "Working"}…</span>
        {stage === "writing" && <span className="tabular-nums text-xs text-muted">{chars.toLocaleString()} characters written</span>}
      </div>
      <ol className="mt-2 grid grid-cols-4 gap-1.5" aria-label="Progress">
        {order.map((s, i) => (
          <li key={s} className={cx("h-1 rounded-full transition-colors", i < idx ? "bg-blue" : i === idx ? "animate-pulse bg-blue/60" : "bg-desk-2")} aria-current={i === idx ? "step" : undefined}>
            <span className="sr-only">{STAGES[s]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function WritingPlaceholder() {
  return (
    <div className="paper mx-auto w-full max-w-[800px] px-5 py-10 sm:px-12">
      <div className="mx-auto mb-6 h-7 w-52 animate-pulse rounded bg-desk-2" />
      {[100, 92, 96, 70, 0, 88, 94, 60].map((w, i) => (
        <div key={i} className={cx("mb-2.5 h-3 rounded bg-desk-2", w > 0 && "animate-pulse")} style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function VersionStrip({ versions, activeKey, onPick, onRemove }: { versions: Version[]; activeKey: string; onPick: (k: string) => void; onRemove: (k: string) => void }) {
  if (versions.length < 1) return null;
  return (
    <div className="no-print mx-auto mb-3 flex max-w-[800px] gap-2 overflow-x-auto pb-1 scroll-thin" role="tablist" aria-label="Versions">
      {versions.map((v) => {
        const on = v.key === activeKey;
        const s = v.result.scores.match.after?.score;
        return (
          <div key={v.key} className={cx("group flex shrink-0 items-center rounded-lg border text-[13px]", on ? "border-blue bg-paper" : "border-rule-soft bg-desk-2/60 hover:border-rule")}>
            <button role="tab" aria-selected={on} onClick={() => onPick(v.key)} className="py-1.5 pl-3 pr-1 text-left">
              <span className={cx(on ? "font-medium text-ink" : "text-ink-2")}>{v.label}</span>
              {s != null && <span className="ml-2 tabular-nums text-muted">match {s}</span>}
            </button>
            <button onClick={() => onRemove(v.key)} className="mr-1 rounded p-1 text-muted opacity-0 hover:text-red focus:opacity-100 group-hover:opacity-100" aria-label={`Remove ${v.label}`}>
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function EmptyDesk() {
  const steps = [
    ["Paste the job description", "The more complete, the better the match — include the requirements."],
    ["Upload your resume", "PDF or DOCX. We read it in memory and show you exactly what we extracted."],
    ["Review every change", "Accept or revert each rewritten line, then download as PDF, Word or text."],
  ];
  return (
    <div className="paper mx-auto w-full max-w-[800px] px-6 py-10 sm:px-14 sm:py-14">
      <h2 className="font-serif text-[26px] font-semibold leading-tight">Your tailored resume appears here.</h2>
      <p className="mt-2 max-w-prose font-serif text-[16px] text-ink-2">
        Tailor rewrites your summary and bullet points in the language of the job, reorders what matters most, and marks the words the{" "}
        <mark className="hl">hiring team is scanning for</mark>. It never adds skills you don&apos;t have.
      </p>
      <ol className="mt-8 space-y-5">
        {steps.map(([title, body], i) => (
          <li key={title} className="flex gap-4">
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-ink/70 font-serif text-sm font-semibold">{i + 1}</span>
            <div>
              <div className="font-medium">{title}</div>
              <p className="text-[14px] text-muted">{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
