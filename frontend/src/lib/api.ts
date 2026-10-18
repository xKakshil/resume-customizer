import type { ChatResponse, ChatTurn, ConfirmedSkill, ExportCheck, HistoryItem, LayoutSettings, ParsedResume, Scores, Section, SupportingDoc, TailoredResume, TailorResult, Tone, User } from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = "error", status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let authToken: string | null = null;
export function setAuthToken(token: string | null) {
  authToken = token;
}

function headers(json = true): HeadersInit {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (authToken) h["Authorization"] = `Bearer ${authToken}`;
  return h;
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status}).`;
  let code = "http_error";
  try {
    const body = await res.json();
    if (body?.error?.message) {
      message = body.error.message;
      code = body.error.code ?? code;
    } else if (typeof body?.detail === "string") {
      message = body.detail;
    }
  } catch {
    /* non-JSON error page (e.g. proxy) */
  }
  if (res.status === 502 || res.status === 504) message = "The server didn't respond in time. Please try again.";
  return new ApiError(message, code, res.status);
}

function networkError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof DOMException && err.name === "AbortError") return new ApiError("Cancelled.", "aborted");
  return new ApiError(
    "Can't reach the server. Check your connection — if the app was idle, the server may be waking up (this can take ~30 seconds).",
    "network",
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, init);
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
export interface Health {
  status: string;
  llm: { provider: string; model: string }[];
  limits: { max_upload_mb: number; min_jd_chars: number; max_jd_chars: number };
}
export const health = (signal?: AbortSignal) => request<Health>("/api/health", { signal });

/** Upload with progress (XHR, because fetch has no upload progress). */
export function parseResume(file: File, onProgress?: (pct: number) => void, signal?: AbortSignal): Promise<ParsedResume> {
  return upload<ParsedResume>("/api/resume/parse", file, onProgress, signal);
}

export interface ParsedDocument {
  text: string;
  filename: string;
  file_type: string;
  size_bytes: number;
  word_count: number;
  warnings: string[];
}

/** Supporting documents (other resumes, project write-ups…): PDF, DOCX, LaTeX, TXT or Markdown. */
export const parseDocument = (file: File, onProgress?: (pct: number) => void) => upload<ParsedDocument>("/api/documents/parse", file, onProgress);

function upload<T>(path: string, file: File, onProgress?: (pct: number) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}${path}`);
    xhr.timeout = 60_000;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: { error?: { message: string; code: string } } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new ApiError(body.error?.message ?? `Upload failed (${xhr.status}).`, body.error?.code ?? "upload_failed", xhr.status));
    };
    xhr.onerror = () => reject(networkError(new Error("network")));
    xhr.ontimeout = () => reject(new ApiError("The upload timed out. Please try again.", "timeout"));
    signal?.addEventListener("abort", () => {
      xhr.abort();
      reject(new ApiError("Cancelled.", "aborted"));
    });
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export const scoreResume = (job_description: string, resume_text: string, signal?: AbortSignal) =>
  request<Scores>("/api/score", { method: "POST", headers: headers(), body: JSON.stringify({ job_description, resume_text }), signal });

// ---------------------------------------------------------------------------
// Server-sent events over fetch (EventSource can't POST).
export type SSEHandler = (event: string, data: Record<string, unknown>) => void;

export async function streamSSE(path: string, body: unknown, onEvent: SSEHandler, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new ApiError("Streaming isn't supported by this browser.", "no_stream");

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let gotTerminal = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue; // keep-alive ping
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        const parsed = JSON.parse(data.join("\n"));
        if (event === "error") throw new ApiError(parsed.message ?? "Generation failed.", parsed.code ?? "stream_error");
        if (event === "result") gotTerminal = true;
        onEvent(event, parsed);
      }
    }
  } catch (e) {
    throw networkError(e);
  }
  if (!gotTerminal) throw new ApiError("The connection closed before the result arrived. Please try again.", "stream_incomplete");
}

export interface TailorParams {
  job_description: string;
  resume_text: string;
  sections: Section[];
  tone: Tone;
  extra_instructions: string;
  resume_filename: string;
  confirmed_skills: ConfirmedSkill[];
  supporting_documents: { label: string; text: string }[];
}

export function tailorStream(
  params: TailorParams,
  handlers: { onStatus?: (s: { stage: string; message?: string; provider?: string }) => void; onDelta?: (text: string) => void },
  signal?: AbortSignal,
): Promise<TailorResult> {
  return new Promise((resolve, reject) => {
    let result: TailorResult | null = null;
    streamSSE(
      "/api/tailor/stream",
      params,
      (event, data) => {
        if (event === "status") handlers.onStatus?.(data as { stage: string });
        else if (event === "delta") handlers.onDelta?.(String(data.text ?? ""));
        else if (event === "result") result = data as unknown as TailorResult;
      },
      signal,
    )
      .then(() => (result ? resolve(result) : reject(new ApiError("No result received.", "no_result"))))
      .catch(reject);
  });
}

export interface CoverLetterParams {
  job_description: string;
  resume_text: string;
  tone: "professional" | "enthusiastic" | "concise" | "storytelling";
  length: "short" | "medium" | "long";
  hiring_manager: string;
  company: string;
}

export function coverLetterStream(params: CoverLetterParams, onDelta: (t: string) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    streamSSE(
      "/api/cover-letter/stream",
      params,
      (event, data) => {
        if (event === "delta") onDelta(String(data.text ?? ""));
        if (event === "result") text = String(data.text ?? "");
      },
      signal,
    )
      .then(() => resolve(text))
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
export type ExportFormat = "pdf" | "docx" | "txt" | "md" | "tex";

export const fetchJD = (url: string) =>
  request<{ job_description: string; title: string; company: string; source: string; url: string; removed_lines: number }>("/api/jd/fetch", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url }),
  });

export interface ExportOptions {
  layout?: LayoutSettings;
  source_id?: string;
}

export const exportCheck = (resume: TailoredResume, opts: ExportOptions = {}) =>
  request<ExportCheck>("/api/export/check", { method: "POST", headers: headers(), body: JSON.stringify({ format: "pdf", resume, ...opts }) });

export interface ChatParams {
  message: string;
  history: ChatTurn[];
  resume: TailoredResume;
  job_description: string;
  resume_text: string;
  layout: LayoutSettings;
  sections: Section[];
  confirmed_skills: ConfirmedSkill[];
  supporting_documents: { label: string; text: string }[];
}

export const chat = (params: ChatParams, signal?: AbortSignal) =>
  request<ChatResponse>("/api/chat", { method: "POST", headers: headers(), body: JSON.stringify(params), signal });

export const toSupporting = (docs: SupportingDoc[]) => docs.map((d) => ({ label: d.label.slice(0, 80) || "Supporting document", text: d.text.slice(0, 20_000) }));

export interface Preview {
  url: string;
  mode: "original-file" | "style-match" | "template";
  note: string;
}

/** Render the resume PDF for the in-app viewer (an object URL the caller must revoke). */
export async function previewPdf(resume: TailoredResume, opts: ExportOptions, signal?: AbortSignal): Promise<Preview> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/export`, { method: "POST", headers: headers(), body: JSON.stringify({ format: "pdf", resume, inline: true, ...opts }), signal });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await toApiError(res);
  const blob = await res.blob();
  return {
    url: URL.createObjectURL(new Blob([blob], { type: "application/pdf" })),
    mode: (res.headers.get("x-render-mode") as Preview["mode"]) || "template",
    note: decodeURIComponent(res.headers.get("x-render-note") || ""),
  };
}

export const cleanJD = (job_description: string) =>
  request<{ job_description: string; removed_lines: number }>("/api/jd/clean", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ job_description }),
  });

/** Fetch the LaTeX source and open it as a new Overleaf project.
 *  The tab is opened synchronously (inside the click) so popup blockers allow it. */
export async function openInOverleaf(resume: TailoredResume, opts: ExportOptions = {}): Promise<void> {
  const win = window.open("", "overleaf");
  try {
    const res = await fetch(`${API_URL}/api/export`, { method: "POST", headers: headers(), body: JSON.stringify({ format: "tex", resume, ...opts }) });
    if (!res.ok) throw await toApiError(res);
    const tex = await res.text();
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "https://www.overleaf.com/docs";
    form.target = "overleaf";
    for (const [name, value] of [["encoded_snip", encodeURIComponent(tex)], ["snip_name", "resume.tex"], ["engine", "pdflatex"]]) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
  } catch (e) {
    win?.close();
    throw e instanceof ApiError ? e : networkError(e);
  }
}

export async function downloadExport(
  body: { format: ExportFormat; resume?: TailoredResume; cover_letter?: string; candidate_name?: string; filename?: string } & ExportOptions,
): Promise<{ mode: string; note: string }> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/export`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await toApiError(res);
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="([^"]+)"/i.exec(cd);
  const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : `download.${body.format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { mode: res.headers.get("x-render-mode") || "template", note: decodeURIComponent(res.headers.get("x-render-note") || "") };
}

// ---------------------------------------------------------------------------
export const auth = {
  register: (email: string, password: string, name: string) =>
    request<{ token: string; user: User }>("/api/auth/register", { method: "POST", headers: headers(), body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>("/api/auth/login", { method: "POST", headers: headers(), body: JSON.stringify({ email, password }) }),
  me: () => request<User>("/api/auth/me", { headers: headers(false) }),
};

export const history = {
  list: () => request<HistoryItem[]>("/api/history", { headers: headers(false) }),
  get: (id: number) =>
    request<{ id: number; job_description: string; resume_text: string; resume_filename: string; result: TailorResult; created_at: string }>(
      `/api/history/${id}`,
      { headers: headers(false) },
    ),
  remove: (id: number) => request<void>(`/api/history/${id}`, { method: "DELETE", headers: headers(false) }),
  attachCoverLetter: (id: number, text: string) =>
    request<{ ok: boolean }>(`/api/history/${id}/cover-letter`, { method: "PUT", headers: headers(), body: JSON.stringify({ text }) }),
};
