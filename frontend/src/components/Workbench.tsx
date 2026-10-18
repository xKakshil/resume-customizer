"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, History, LogOut, PencilLine, Plus, Sparkles, Square, Highlighter, X, RotateCw, AlertTriangle, ClipboardList, SlidersHorizontal, MessageSquareText } from "lucide-react";
import { ApiError, chat as chatApi, cleanJD, fetchJD, health, history as historyApi, parseDocument, parseResume, scoreResume, setAuthToken, tailorStream, toSupporting, auth } from "@/lib/api";
import type { ChatMessage, ConfirmedSkill, LayoutSettings, ParsedResume, Scores, Section, SupportingDoc, TailoredResume, Tone, User, Version } from "@/lib/types";
import { DEFAULT_SECTIONS } from "@/lib/types";
import { DEFAULT_LAYOUT, fromStyle, normalizeLayout, originalMode } from "@/lib/layout";
import { changeCount, effectiveResume, timeAgo } from "@/lib/resume";
import { parsePartialResume } from "@/lib/partial";
import { KEYS, load, save } from "@/lib/storage";
import { SAMPLE_JD, SAMPLE_RESUME_URL } from "@/lib/sample";
import { JDInput, MAX_DOCS, MAX_JD, MIN_JD, Options, ResumeUpload, SupportingDocs, TONES, validateFile } from "./InputPanel";
import { OriginalPaper, ResumePaper } from "./ResumePaper";
import { ChangesView } from "./ChangesView";
import { BaselineInsights, InsightsView } from "./InsightsView";
import { CoverLetterView } from "./CoverLetterView";
import { CompareView } from "./CompareView";
import { PdfPreview } from "./PdfPreview";
import { PageSetup } from "./PageSetup";
import { ChatPanel } from "./ChatPanel";
import { DownloadMenu } from "./DownloadMenu";
import { AuthDialog, HistoryDrawer } from "./AccountUI";
import { useTermsRegex } from "./highlight";
import { Button, cx, useToast } from "./ui";

type Tab = "resume" | "pdf" | "changes" | "insights" | "cover" | "compare";
type Rail = "inputs" | "design" | "chat";
const MAX_VERSIONS = 6;
/** Toolbar width follows the content below it so edges line up. */
const WIDTH: Record<Tab, string> = {
  resume: "max-w-[800px]",
  pdf: "max-w-[900px]",
  changes: "max-w-[1000px]",
  insights: "max-w-[800px]",
  compare: "max-w-[1100px]",
  cover: "max-w-[800px]",
};
const uid = () => Math.random().toString(36).slice(2, 10);
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
  const [sections, setSectionsRaw] = useState<Section[]>(DEFAULT_SECTIONS);
  const [layout, setLayoutRaw] = useState<LayoutSettings>(DEFAULT_LAYOUT);
  const [docs, setDocs] = useState<SupportingDoc[]>([]);
  // "Include a summary" and the page-setup "Show summary" are one setting.
  const setSections = (next: Section[]) => {
    setSectionsRaw(next);
    setLayoutRaw((l) => ({ ...l, show_summary: next.includes("summary") }));
  };
  const setLayout = (next: LayoutSettings) => {
    setLayoutRaw(next);
    setSectionsRaw((ss) => (next.show_summary ? (ss.includes("summary") ? ss : ["summary", ...ss]) : ss.filter((x) => x !== "summary")));
  };
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
  const [rail, setRail] = useState<Rail>("inputs");
  // After the first version, the job post and options fold into one-line summaries.
  const [open, setOpen] = useState<{ jd: boolean; options: boolean }>({ jd: false, options: false });
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({});
  const [chatBusy, setChatBusy] = useState(false);
  const [undo, setUndo] = useState<{ id: string; prev: Version; prevLayout: LayoutSettings } | null>(null);
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
    const savedLayout = load<Partial<LayoutSettings> | null>(KEYS.layout, null);
    const lay = normalizeLayout(savedLayout);
    setLayoutRaw(lay);
    // Older saves defaulted to rewriting the summary; it's opt-in now.
    if (opts.sections?.length) setSectionsRaw(savedLayout ? opts.sections : opts.sections.filter((x) => x !== "summary"));
    setDocs(load<SupportingDoc[]>(KEYS.docs, []));
    setChats(load<Record<string, ChatMessage[]>>(KEYS.chat, {}));
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
  useEffect(() => void (hydrated && save(KEYS.layout, layout)), [layout, hydrated]);
  useEffect(() => void (hydrated && save(KEYS.docs, docs)), [docs, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    // Keep chats for versions that still exist; drop proposals' heavy payloads once decided.
    const keep: Record<string, ChatMessage[]> = {};
    for (const v of versions) if (chats[v.key]?.length) keep[v.key] = chats[v.key].slice(-30).map((m) => (m.status && m.status !== "pending" ? { ...m, proposal: m.proposal && { ...m.proposal, result: null } } : m));
    save(KEYS.chat, keep);
  }, [chats, versions, hydrated]);

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
      // Keep the look of the uploaded file until the user picks another template.
      if (originalMode(p).available) setLayoutRaw((l) => fromStyle(p.style, l));
      else setLayoutRaw((l) => (l.template === "original" ? { ...l, template: "classic" } : l));
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

  const addDoc = (d: Omit<SupportingDoc, "id">) => setDocs((ds) => [...ds, { ...d, id: uid() }].slice(0, MAX_DOCS));
  const uploadDoc = async (f: File) => {
    if (f.size > 5 * 1024 * 1024) {
      toast("error", "That file is over 5 MB.");
      return;
    }
    try {
      const d = await parseDocument(f);
      addDoc({ label: f.name.replace(/\.[^.]+$/, "").slice(0, 80), text: d.text, filename: f.name, word_count: d.word_count });
      toast("success", `Added ${f.name} (${d.word_count} words) as extra material.`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

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
    setTab((t) => (t === "pdf" ? "pdf" : "resume"));
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
          supporting_documents: toSupporting(docs),
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
    if (undo?.prev.key === key) setUndo(null);
    setVersions((vs) => {
      const next = vs.filter((v) => v.key !== key);
      if (key === activeKey) setActiveKey(next.length ? next[next.length - 1].key : null);
      if (next.length < 2 && tab === "compare") setTab("resume");
      return next;
    });
  };

  // --- chat: the AI proposes, the user applies ----------------------------------
  const setChat = (key: string, fn: (ms: ChatMessage[]) => ChatMessage[]) => setChats((c) => ({ ...c, [key]: fn(c[key] ?? []) }));
  const sendChat = async (message: string) => {
    if (!active || !parsed) return;
    const key = active.key;
    const prior = (chats[key] ?? []).filter((m) => !m.error).slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    setChat(key, (ms) => [...ms, { id: uid(), role: "user", content: message }]);
    setChatBusy(true);
    try {
      const res = await chatApi({
        message,
        history: prior,
        resume: effectiveResume(active),
        job_description: jd,
        resume_text: parsed.text,
        layout,
        sections: active.result.meta.sections ?? sections,
        confirmed_skills: confirmed,
        supporting_documents: toSupporting(docs),
      });
      const useful = res.proposal && (res.proposal.result || res.proposal.layout);
      setChat(key, (ms) => [...ms, { id: uid(), role: "assistant", content: res.reply, changes: res.changes, proposal: useful ? res.proposal : null, baseLayout: useful ? layout : undefined, status: useful ? "pending" : undefined }]);
    } catch (e) {
      setChat(key, (ms) => [...ms, { id: uid(), role: "assistant", content: (e as Error).message, error: true }]);
    } finally {
      setChatBusy(false);
    }
  };
  const applyProposal = (id: string) => {
    if (!active) return;
    const msg = (chats[active.key] ?? []).find((m) => m.id === id);
    const p = msg?.proposal;
    if (!p) return;
    setUndo({ id, prev: active, prevLayout: layout });
    if (p.result) {
      const result = { ...p.result, id: active.result.id, cover_letter: active.result.cover_letter };
      // The proposal was made from the effective resume (decisions and edits already baked in).
      updateActive((v) => ({ ...v, result, rejected: {}, edits: {} }));
    }
    if (p.layout) setLayout(p.layout);
    // Other pending proposals were made against the old text — applying them now would undo this one.
    setChat(active.key, (ms) => ms.map((m) => (m.id === id ? { ...m, status: "applied" } : m.status === "pending" ? { ...m, status: "discarded" } : m)));
    toast("success", p.result ? "Change applied. Undo is in the chat." : "Page setup updated.");
  };
  const discardProposal = (id: string) => active && setChat(active.key, (ms) => ms.map((m) => (m.id === id ? { ...m, status: "discarded" } : m)));
  const undoProposal = (id: string) => {
    if (!undo || undo.id !== id) return;
    setVersions((vs) => vs.map((v) => (v.key === undo.prev.key ? undo.prev : v)));
    setLayout(undo.prevLayout);
    setChat(undo.prev.key, (ms) => ms.map((m) => (m.id === id ? { ...m, status: "pending" } : m)));
    setUndo(null);
    toast("info", "Undone.");
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
  const effective = useMemo(() => (active ? effectiveResume(active) : null), [active]);
  const exportOpts = useMemo(() => ({ layout, source_id: parsed?.source_id || undefined }), [layout, parsed?.source_id]);
  const look = { font: layout.font_family, align: layout.header_align } as const;
  const jdTitle = active ? [active.result.resume.jd_analysis.role_title, active.result.resume.jd_analysis.company].filter(Boolean).join(" at ") : "";
  const jdSummary = jdTitle || jd.trim().split("\n")[0].slice(0, 80) || "Not added";
  const optionsSummary = [
    sections.filter((x) => x !== "summary").map((x) => x[0].toUpperCase() + x.slice(1)).join(", "),
    TONES.find((t) => t.value === tone)?.label,
    sections.includes("summary") ? "with summary" : "no summary",
  ]
    .filter(Boolean)
    .join(", ");
  const openRail = (r: Rail) => {
    setRail(r);
    if (r === "design" && active && tab !== "pdf") setTab("pdf");
  };

  // --- render -------------------------------------------------------------------
  return (
    <div className="flex min-h-screen flex-col">
      <header className="no-print sticky top-0 z-40 border-b border-rule-soft bg-desk/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-3 px-4 sm:px-6 lg:gap-8">
          <Link href="/" className="mr-auto flex shrink-0 items-center gap-2 text-[19px] font-bold tracking-tight lg:mr-0 lg:w-[380px] xl:w-[420px]">
            <span className="relative">
              <span className="absolute inset-x-[-3px] -bottom-[1px] h-[6px] -skew-x-6 rounded-sm bg-hl" aria-hidden />
              <span className="relative">Tailor</span>
            </span>
          </Link>
          <Steps
            steps={[
              { label: "Job post", done: jdValid },
              { label: "Resume", done: !!parsed },
              { label: "Tailor", done: versions.length > 0, busy: streaming },
              { label: "Review & download", done: false, current: versions.length > 0 && !streaming },
            ]}
          />
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

      <main className="mx-auto grid w-full max-w-[1500px] flex-1 grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[380px_minmax(0,1fr)] lg:gap-8 xl:grid-cols-[420px_minmax(0,1fr)]">
        {/* ---------------- Left rail: inputs · page setup · chat ---------------- */}
        <aside className="no-print flex flex-col lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)]">
          <nav className="mb-5 grid grid-cols-3 rounded-xl border border-rule-soft bg-paper/70 p-1 shadow-[0_1px_0_rgba(22,35,59,0.04)]" aria-label="Panels">
            {(
              [
                ["inputs", "Inputs", ClipboardList],
                ["design", "Page setup", SlidersHorizontal],
                ["chat", "Ask AI", MessageSquareText],
              ] as [Rail, string, typeof ClipboardList][]
            ).map(([r, label, Icon]) => (
              <button
                key={r}
                onClick={() => openRail(r)}
                aria-current={rail === r ? "page" : undefined}
                className={cx("flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[13px] transition-colors", rail === r ? "bg-ink font-medium text-paper" : "text-ink-2 hover:bg-desk-2 hover:text-ink")}
              >
                <Icon className="size-3.5" aria-hidden /> {label}
                {r === "chat" && active && (chats[active.key] ?? []).some((m) => m.status === "pending") && <span className="size-1.5 rounded-full bg-hl" aria-label="Pending proposal" />}
              </button>
            ))}
          </nav>

          <div className={cx("min-h-0 flex-1 lg:overflow-y-auto lg:pr-1 scroll-thin", rail !== "inputs" && "hidden")}>
            {!versions.length && (
              <>
                <h1 className="text-[28px] font-bold leading-[1.08] tracking-[-0.02em]">Fit your resume to the job.</h1>
                <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">Small, honest edits you approve line by line, in your own template.</p>
                {!parsed && !jd && (
                  <button onClick={loadSample} className="mt-1.5 text-sm font-medium text-blue underline-offset-2 hover:underline">
                    Try a sample resume and job
                  </button>
                )}
              </>
            )}

            <div className={cx("space-y-5", !versions.length && "mt-5")}>
              {versions.length > 0 && !open.jd ? (
                <Folded title="Job post" summary={jdSummary} onOpen={() => setOpen((o) => ({ ...o, jd: true }))} disabled={streaming} />
              ) : (
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
              )}
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
              {parsed && (
                <SupportingDocs
                  docs={docs}
                  onAdd={addDoc}
                  onUpload={uploadDoc}
                  onRemove={(id) => setDocs((ds) => ds.filter((d) => d.id !== id))}
                  onRename={(id, label) => setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, label } : d)))}
                  disabled={streaming}
                />
              )}
              {versions.length > 0 && !open.options ? (
                <Folded title="Options" summary={optionsSummary} onOpen={() => setOpen((o) => ({ ...o, options: true }))} disabled={streaming} />
              ) : (
                <Options sections={sections} tone={tone} extra={extra} onSections={setSections} onTone={setTone} onExtra={setExtra} disabled={streaming} />
              )}

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
                  <p className="mt-1 text-xs text-muted">Not in your resume, but you said you have them.</p>
                </div>
              )}

              <div className="sticky bottom-0 -mx-1 bg-desk px-1 pb-1 pt-2">
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
          </div>

          {rail === "design" && (
            <div className="min-h-0 flex-1 lg:overflow-y-auto lg:pr-1 scroll-thin">
              <PageSetup layout={layout} onChange={setLayout} parsed={parsed} />
              {!active && <p className="mt-4 text-xs text-muted">Settings apply to the PDF view and every download once your resume is tailored.</p>}
            </div>
          )}

          {rail === "chat" && (
            <div className="min-h-0 flex-1 lg:overflow-hidden">
              <ChatPanel
                version={active}
                layout={layout}
                messages={active ? (chats[active.key] ?? []) : []}
                busy={chatBusy}
                onSend={sendChat}
                onApply={applyProposal}
                onDiscard={discardProposal}
                onUndo={undoProposal}
                undoId={undo && active && undo.prev.key === active.key ? undo.id : null}
                onClear={() => active && setChat(active.key, () => [])}
              />
            </div>
          )}
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
                <ResumePaper resume={partial} version={null} re={null} streaming showSummary={sections.includes("summary")} look={look} />
              ) : (
                <WritingPlaceholder />
              )}
            </div>
          ) : active ? (
            <div>
              <VersionStrip versions={versions} activeKey={active.key} onPick={setActiveKey} onRemove={removeVersion} width={WIDTH[tab]} />
              <div className={cx("no-print mx-auto mb-4 flex flex-wrap items-end gap-2 border-b border-rule", WIDTH[tab])}>
                <nav className="-mb-px flex flex-wrap" aria-label="Result views">
                  {(
                    [
                      ["resume", "Resume"],
                      ["pdf", "PDF view"],
                      ["changes", "Changes"],
                      ["insights", "Insights"],
                      ["compare", "Compare"],
                      ["cover", "Cover letter"],
                    ] as [Tab, string][]
                  ).map(([t, label]) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      aria-current={tab === t ? "page" : undefined}
                      className={cx("border-b-2 px-3 pb-2.5 pt-1.5 text-[14px] transition-colors", tab === t ? "border-ink font-semibold text-ink" : "border-transparent text-muted hover:border-rule hover:text-ink")}
                    >
                      {label}
                      {t === "insights" && active.result.scores.match.after?.score != null && <span className="ml-1.5 tabular-nums text-blue">{active.result.scores.match.after.score}</span>}
                      {t === "compare" && versions.length > 1 && <span className="ml-1.5 text-muted">{versions.length}</span>}
                      {t === "changes" && <span className="ml-1.5 tabular-nums text-muted">{changeCount(active.result.resume).changed}</span>}
                    </button>
                  ))}
                </nav>
                <span className="flex-1" />
                <div className="flex items-center gap-1 pb-2">
                {tab === "resume" && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setHighlightOn((h) => !h)} aria-pressed={highlightOn} title="Highlight job keywords">
                      <Highlighter className={cx("size-4", highlightOn && "text-amber")} />
                      <span className="sr-only">Highlight keywords</span>
                    </Button>
                    <Button variant={editing ? "primary" : "ghost"} size="sm" onClick={() => setEditing((e) => !e)} aria-pressed={editing}>
                      <PencilLine className="size-4" /> {editing ? "Done" : "Edit"}
                    </Button>
                  </>
                )}
                <DownloadMenu getResume={getEffective} opts={exportOpts} original={parsed} />
                </div>
              </div>
              {tab !== "insights" && tab !== "compare" && <ScoreStrip version={active} onOpen={() => setTab("insights")} width={WIDTH[tab]} />}

              {tab === "resume" && (
                <>
                  {editing && <p className="no-print mx-auto mb-2 max-w-[800px] text-center text-[13px] text-muted">Click any line to edit it. Your edits are used in every download.</p>}
                  <ResumePaper resume={active.result.resume} version={active} re={re} editable={editing} onEdit={editUnit} showSummary={layout.show_summary} look={look} />
                </>
              )}
              {tab === "pdf" && effective && <PdfPreview resume={effective} layout={layout} sourceId={parsed?.source_id} onOpenSetup={() => openRail("design")} />}
              {tab === "changes" && <ChangesView version={active} resumeText={parsed?.text ?? ""} onToggle={toggleDecision} onRevertAll={revertAll} />}
              {tab === "insights" && (
                <InsightsView
                  result={active.result}
                  confirmed={confirmed}
                  onConfirm={confirmSkill}
                  onUnconfirm={unconfirmSkill}
                  onRegenerate={tailor}
                  busy={streaming}
                  layout={parsed?.layout}
                  getResume={getEffective}
                  exportOpts={exportOpts}
                  key={active.key}
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
              <div className="no-print mx-auto mb-4 flex max-w-[800px] flex-wrap items-end gap-x-4 gap-y-1 border-b border-rule">
                <nav className="-mb-px flex" aria-label="Preview views">
                  {(
                    [
                      ["resume", "Your resume as read"],
                      ["insights", baseline ? `Fit check  ${baseline.match.before.score ?? "—"}` : "Fit check"],
                    ] as ["resume" | "insights", string][]
                  ).map(([t, label]) => (
                    <button key={t} onClick={() => setPreTab(t)} disabled={t === "insights" && !baseline} className={cx("border-b-2 px-3 pb-2.5 pt-1.5 text-[14px] disabled:opacity-40", preTab === t ? "border-ink font-semibold text-ink" : "border-transparent text-muted hover:text-ink")}>
                      {label}
                    </button>
                  ))}
                </nav>
                <p className="pb-2.5 text-[13px] text-muted">{baseline ? "Highlighted words already match the job." : "Paste the job description to see how well this fits."}</p>
              </div>
              {preTab === "insights" && baseline ? <BaselineInsights match={baseline.match.before} ats={baseline.ats.before} layout={parsed.layout} /> : <OriginalPaper text={parsed.text} re={re} />}
            </div>
          ) : (
            <EmptyDesk />
          )}
        </section>
      </main>

      <footer className="no-print border-t border-rule-soft px-4 py-4 text-center text-xs text-muted">
        Tailor never invents experience — skills you don&apos;t have are suggested, not added. Your original file is kept for 48 hours so downloads can reuse its template, then deleted. Results are saved only if you sign in.
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

function VersionStrip({ versions, activeKey, onPick, onRemove, width }: { versions: Version[]; activeKey: string; onPick: (k: string) => void; onRemove: (k: string) => void; width: string }) {
  if (versions.length < 1) return null;
  return (
    <div className={cx("no-print mx-auto mb-3 flex items-center gap-1.5 overflow-x-auto pb-1 scroll-thin", width)} role="tablist" aria-label="Versions">
      {versions.map((v) => {
        const on = v.key === activeKey;
        const s = v.result.scores.match.after?.score;
        return (
          <div key={v.key} className={cx("group flex shrink-0 items-center rounded-full text-[13px] transition-colors", on ? "bg-ink text-paper" : "bg-paper/80 text-ink-2 ring-1 ring-rule-soft hover:ring-rule")}>
            <button role="tab" aria-selected={on} onClick={() => onPick(v.key)} className="py-1 pl-3 pr-1 text-left">
              <span className={cx(on && "font-medium")}>{v.label}</span>
              {s != null && <span className={cx("ml-2 tabular-nums", on ? "text-paper/70" : "text-muted")}>{s}</span>}
            </button>
            <button onClick={() => onRemove(v.key)} className={cx("mr-1 rounded-full p-1 opacity-0 focus:opacity-100 group-hover:opacity-100", on ? "hover:bg-paper/15" : "text-muted hover:text-red")} aria-label={`Remove ${v.label}`}>
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function EmptyDesk() {
  const steps = [
    ["Add the job post", "Paste it or import it from a link. Requirements and nice-to-haves both count."],
    ["Upload your resume", "PDF, Word or LaTeX. Your template is kept for the downloads."],
    ["Review and download", "Accept or revert each line, ask the AI for more, then download."],
  ];
  return (
    <div className="paper mx-auto w-full max-w-[800px] overflow-hidden">
      <div className="px-6 pb-8 pt-10 sm:px-14 sm:pt-14">
        <h2 className="max-w-[22ch] font-serif text-[32px] font-semibold leading-[1.1] tracking-[-0.01em] sm:text-[38px]">Your resume, proofread against the job.</h2>
        <p className="mt-3 max-w-[58ch] font-serif text-[16.5px] leading-[1.65] text-ink-2">
          Tailor marks up your resume like an editor would: it tightens the lines that need it, uses the words the hiring team is scanning for, and leaves strong lines alone. It never adds a skill you don&apos;t have.
        </p>
      </div>

      <figure className="border-y border-rule-soft bg-desk/40 px-6 py-7 sm:px-14" aria-label="Example edit">
        <div className="grid gap-x-8 gap-y-3 sm:grid-cols-[minmax(0,1fr)_180px]">
          <p className="demo font-serif text-[17px] leading-[1.75] text-ink">
            <span className="text-ink-2">•</span> <del className="demo-del">Responsible for building</del> <ins className="demo-ins">Built</ins>{" "}
            <mark className="demo-hl" style={{ animationDelay: "1.5s" }}>REST APIs</mark> in Node.js and Express backed by{" "}
            <mark className="demo-hl" style={{ animationDelay: "1.8s" }}>Postgres</mark>, cutting p95 latency by 35%.
          </p>
          <figcaption className="demo-note border-l-2 border-hl pl-3 text-[13px] leading-snug text-ink-2">
            The job asks for REST APIs and PostgreSQL. Your number stays exactly as you wrote it.
          </figcaption>
        </div>
        <p className="mt-4 font-serif text-[15.5px] leading-[1.7] text-muted">
          <span>•</span> Wrote unit tests with Jest and set up GitHub Actions CI. <span className="font-sans text-[12.5px] text-green">Kept as written</span>
        </p>
      </figure>

      <ol className="grid gap-6 px-6 py-8 sm:grid-cols-3 sm:px-14">
        {steps.map(([title, body], i) => (
          <li key={title}>
            <span className="grid size-7 place-items-center rounded-full border border-ink/70 font-serif text-sm font-semibold">{i + 1}</span>
            <div className="mt-2 font-medium">{title}</div>
            <p className="mt-0.5 text-[13.5px] leading-snug text-muted">{body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Steps({ steps }: { steps: { label: string; done: boolean; busy?: boolean; current?: boolean }[] }) {
  const firstOpen = steps.findIndex((s) => !s.done);
  return (
    <ol className="mr-auto hidden items-center gap-1 text-[13px] md:flex" aria-label="Progress">
      {steps.map((s, i) => {
        const current = s.current || s.busy || (!steps.some((x) => x.current) && i === firstOpen);
        return (
          <li key={s.label} className="flex items-center gap-1" aria-current={current ? "step" : undefined}>
            {i > 0 && <span className={cx("mx-1 h-px w-5", steps[i - 1].done ? "bg-ink/40" : "bg-rule")} aria-hidden />}
            <span
              className={cx(
                "grid size-5 place-items-center rounded-full text-[11px] font-semibold tabular-nums",
                s.done ? "bg-ink text-paper" : current ? "bg-hl text-[#16233b]" : "border border-rule text-muted",
              )}
            >
              {s.done ? <Check className="size-3" strokeWidth={3} aria-hidden /> : i + 1}
            </span>
            <span className={cx(s.done || current ? "text-ink" : "text-muted", current && "font-medium")}>
              {s.label}
              {s.busy && <span className="sr-only"> (in progress)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Folded({ title, summary, onOpen, disabled }: { title: string; summary: string; onOpen: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className="group flex w-full items-center gap-3 rounded-lg border border-rule bg-paper px-3 py-2.5 text-left transition-colors hover:border-ink-2 disabled:opacity-60"
    >
      <Check className="size-4 shrink-0 text-green" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] text-muted">{title}</span>
        <span className="block truncate text-sm font-medium">{summary}</span>
      </span>
      <span className="text-[13px] font-medium text-blue group-hover:underline">Edit</span>
    </button>
  );
}

function ScoreStrip({ version, onOpen, width }: { version: Version; onOpen: () => void; width: string }) {
  const s = version.result.scores;
  const after = s.match.after ?? s.match.before;
  const before = s.match.before.score;
  const st = version.result.stats;
  const flagged = version.result.guardrails.flagged_bullets;
  const items: [string, React.ReactNode][] = [
    [
      "Keyword match",
      <>
        {before != null && after.score != null && before !== after.score && <span className="mr-1 font-normal text-muted line-through decoration-muted/50">{before}</span>}
        {after.score ?? "—"}
      </>,
    ],
    ["Must-haves", `${after.required_matched ?? 0} of ${after.required_total ?? 0}`],
    ["ATS readiness", String((s.ats.after ?? s.ats.before).score)],
    ["Lines edited", st ? `${st.light + st.rewritten + st.new} of ${st.total}` : String(changeCount(version.result.resume).changed)],
  ];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx("no-print mx-auto mb-5 flex w-full flex-wrap items-stretch gap-x-6 gap-y-2 rounded-lg px-1 text-left", width)}
      title="Open insights"
    >
      {items.map(([label, value]) => (
        <span key={label} className="flex items-baseline gap-2">
          <span className="text-[12.5px] text-muted">{label}</span>
          <span className="text-[15px] font-semibold tabular-nums">{value}</span>
        </span>
      ))}
      {flagged > 0 && (
        <span className="flex items-baseline gap-1.5 text-[12.5px] text-red">
          <span className="size-1.5 translate-y-[-1px] rounded-full bg-red" aria-hidden />
          {flagged} line{flagged > 1 ? "s" : ""} to check
        </span>
      )}
      <span className="ml-auto self-center text-[12.5px] font-medium text-blue">Details</span>
    </button>
  );
}
