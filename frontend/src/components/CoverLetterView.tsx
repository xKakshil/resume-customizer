"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Square, Wand2 } from "lucide-react";
import { ApiError, coverLetterStream, downloadExport, history, type CoverLetterParams, type ExportFormat } from "@/lib/api";
import { Button, Segmented, copyText, cx, useToast } from "./ui";

type Tone = CoverLetterParams["tone"];
type Length = CoverLetterParams["length"];

export function CoverLetterView({
  jd,
  resumeText,
  candidateName,
  defaultCompany,
  initial,
  runId,
  signedIn,
  onChange,
}: {
  jd: string;
  resumeText: string;
  candidateName: string;
  defaultCompany: string;
  initial?: string;
  runId?: number;
  signedIn: boolean;
  onChange: (text: string) => void;
}) {
  const toast = useToast();
  const [tone, setTone] = useState<Tone>("professional");
  const [length, setLength] = useState<Length>("medium");
  const [manager, setManager] = useState("");
  const [company, setCompany] = useState(defaultCompany);
  const [text, setText] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const generate = async () => {
    setError(null);
    setBusy(true);
    setText("");
    abort.current = new AbortController();
    let acc = "";
    try {
      const final = await coverLetterStream(
        { job_description: jd, resume_text: resumeText, tone, length, hiring_manager: manager, company },
        (d) => {
          acc += d;
          setText(acc);
        },
        abort.current.signal,
      );
      setText(final);
      onChange(final);
      if (runId && signedIn) history.attachCoverLetter(runId, final).catch(() => {});
    } catch (e) {
      const err = e as ApiError;
      if (err.code !== "aborted") setError(err.message);
      if (acc) onChange(acc);
    } finally {
      setBusy(false);
    }
  };

  const download = async (format: ExportFormat) => {
    try {
      await downloadExport({ format, cover_letter: text, candidate_name: candidateName });
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="mx-auto grid w-full max-w-[800px] gap-4">
      <section className="rounded-lg border border-rule-soft bg-paper p-4 sm:p-5">
        <h2 className="text-[17px] font-semibold">Cover letter</h2>
        <p className="mb-4 text-sm text-muted">Written from your resume and this job description — no invented experience.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 text-sm font-medium">Voice</div>
            <Segmented
              label="Voice"
              value={tone}
              onChange={setTone}
              disabled={busy}
              options={[
                { value: "professional", label: "Professional" },
                { value: "enthusiastic", label: "Warm" },
                { value: "concise", label: "Direct" },
                { value: "storytelling", label: "Story" },
              ]}
            />
          </div>
          <div>
            <div className="mb-1.5 text-sm font-medium">Length</div>
            <Segmented
              label="Length"
              value={length}
              onChange={setLength}
              disabled={busy}
              options={[
                { value: "short", label: "Short", hint: "150–200 words" },
                { value: "medium", label: "Medium", hint: "250–330 words" },
                { value: "long", label: "Long", hint: "380–450 words" },
              ]}
            />
          </div>
          <label className="text-sm">
            <span className="mb-1.5 block font-medium">Hiring manager</span>
            <input value={manager} onChange={(e) => setManager(e.target.value)} maxLength={100} disabled={busy} placeholder="Optional — e.g. Priya Menon" className="h-10 w-full rounded-lg border border-rule bg-paper px-3 outline-none focus:border-blue" />
          </label>
          <label className="text-sm">
            <span className="mb-1.5 block font-medium">Company</span>
            <input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={100} disabled={busy} placeholder="Taken from the JD if empty" className="h-10 w-full rounded-lg border border-rule bg-paper px-3 outline-none focus:border-blue" />
          </label>
        </div>
        <div className="mt-4 flex gap-2">
          {busy ? (
            <Button onClick={() => abort.current?.abort()}>
              <Square className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={generate}>
              <Wand2 className="size-4" /> {text ? "Write a new draft" : "Write cover letter"}
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red">
            {error}
          </p>
        )}
      </section>

      {(text || busy) && (
        <section className="paper px-5 py-6 sm:px-12 sm:py-10">
          {busy ? (
            <div className="paper-text whitespace-pre-wrap text-[15px] leading-7">
              {text}
              <span className="caret" aria-hidden />
            </div>
          ) : (
            <textarea
              aria-label="Cover letter text"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                onChange(e.target.value);
              }}
              className="paper-text scroll-thin block min-h-[28rem] w-full resize-y bg-transparent text-[15px] leading-7 outline-none"
            />
          )}
          {!busy && (
            <div className={cx("no-print mt-4 flex flex-wrap items-center gap-2 border-t border-rule-soft pt-4")}>
              <span className="mr-auto text-xs text-muted">{words} words · edit directly above</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const ok = await copyText(text);
                  toast(ok ? "success" : "error", ok ? "Copied to clipboard." : "Couldn't copy — select the text instead.");
                }}
              >
                <Copy className="size-3.5" /> Copy
              </Button>
              <Button size="sm" onClick={() => download("pdf")}>PDF</Button>
              <Button size="sm" onClick={() => download("docx")}>Word</Button>
              <Button size="sm" onClick={() => download("txt")}>Text</Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
