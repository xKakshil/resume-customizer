"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, FileCheck2, Loader2, RotateCw, SlidersHorizontal } from "lucide-react";
import { previewPdf, type Preview } from "@/lib/api";
import type { LayoutSettings, TailoredResume } from "@/lib/types";
import { Button, cx } from "./ui";

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return m;
  });
  return pdfjsPromise;
}

/** Draw every page onto canvases (works the same on phones, where inline PDF viewers don't). */
function PdfPages({ url, onPages, onFail }: { url: string; onPages: (n: number) => void; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        const data = await (await fetch(url)).arrayBuffer();
        const task = pdfjs.getDocument({ data });
        const doc = await task.promise;
        if (cancelled || !host.current) return;
        const width = host.current.clientWidth || 800;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const canvases: HTMLCanvasElement[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * ratio });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.className = "paper block h-auto w-full bg-white";
          canvas.setAttribute("aria-label", `Page ${i} of ${doc.numPages}`);
          await page.render({ canvas, viewport }).promise;
          if (cancelled) return;
          canvases.push(canvas);
        }
        host.current?.replaceChildren(...canvases);
        onPages(doc.numPages);
        void task.destroy();
      } catch {
        if (!cancelled) onFail();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return <div ref={host} className="space-y-4" />;
}

const MODE_LABEL: Record<Preview["mode"], string> = {
  "original-file": "Your original template",
  "style-match": "Matched to your original",
  template: "Template",
};

/** The real PDF exactly as it will download, re-rendered (debounced) whenever the
 *  content or page setup changes. */
export function PdfPreview({ resume, layout, sourceId, onOpenSetup }: { resume: TailoredResume; layout: LayoutSettings; sourceId?: string; onOpenSetup?: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [pages, setPages] = useState<number | null>(null);
  const [fallback, setFallback] = useState(false);
  const urlRef = useRef<string | null>(null);
  const key = useMemo(() => JSON.stringify([resume, layout, sourceId]), [resume, layout, sourceId]);

  useEffect(() => {
    const ctrl = new AbortController();
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const p = await previewPdf(resume, { layout, source_id: sourceId || undefined }, ctrl.signal);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = p.url;
        setPreview(p);
        setError(null);
      } catch (e) {
        if ((e as { code?: string }).code !== "aborted") setError((e as Error).message);
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    }, 450);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // `key` captures resume/layout/sourceId by value so edits re-render but identical objects don't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  useEffect(() => () => void (urlRef.current && URL.revokeObjectURL(urlRef.current)), []);

  return (
    <div className="mx-auto w-full max-w-[900px]">
      <div className="no-print mb-2 flex flex-wrap items-center gap-2 text-[13px]">
        {preview && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-paper px-2.5 py-1 font-medium text-ink-2 shadow-sm">
            <FileCheck2 className="size-3.5 text-green" /> {MODE_LABEL[preview.mode]}
          </span>
        )}
        <span className="text-muted">
          {layout.page_size} · {layout.margins.top}/{layout.margins.right}/{layout.margins.bottom}/{layout.margins.left}″ · {layout.font_family} {layout.font_size}pt
        </span>
        {pages != null && <span className="text-muted">· {pages} page{pages > 1 ? "s" : ""}</span>}
        {pages != null && pages > 1 && layout.one_page && <span className="text-amber">· doesn&apos;t fit one page — try smaller margins or ask the AI to trim</span>}
        {busy && (
          <span className="inline-flex items-center gap-1 text-muted">
            <Loader2 className="size-3.5 animate-spin" /> Rendering
          </span>
        )}
        <span className="flex-1" />
        {onOpenSetup && (
          <Button size="sm" variant="ghost" onClick={onOpenSetup}>
            <SlidersHorizontal className="size-3.5" /> Page setup
          </Button>
        )}
        {preview && (
          <a href={preview.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-blue hover:bg-desk-2">
            <ExternalLink className="size-3.5" /> Open
          </a>
        )}
      </div>
      {preview?.note && (
        <p className="no-print mb-2 rounded-md bg-amber-wash px-3 py-1.5 text-[12.5px] text-amber" role="status">
          {preview.note}
        </p>
      )}
      {error ? (
        <div role="alert" className="paper flex flex-col items-center gap-3 px-6 py-16 text-center">
          <AlertTriangle className="size-6 text-red" />
          <p className="max-w-md text-sm text-ink-2">{error}</p>
          <Button size="sm" onClick={() => setNonce((n) => n + 1)}>
            <RotateCw className="size-3.5" /> Try again
          </Button>
        </div>
      ) : preview && fallback ? (
        <div className="paper relative overflow-hidden">
          <iframe key={preview.url} src={`${preview.url}#toolbar=1&navpanes=0&view=FitH`} title="Resume PDF preview" className="block h-[calc(100vh-13rem)] min-h-[640px] w-full bg-white" />
        </div>
      ) : preview ? (
        <div className={cx("relative transition-opacity", busy && "opacity-60")}>
          <PdfPages url={preview.url} onPages={setPages} onFail={() => setFallback(true)} />
        </div>
      ) : (
        <div className="paper grid h-[640px] place-items-center text-muted">
          <Loader2 className="size-6 animate-spin" aria-label="Rendering PDF" />
        </div>
      )}
      <p className="no-print mt-2 text-center text-xs text-muted">This is the exact PDF you&apos;ll download.</p>
    </div>
  );
}
