"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, Download, ExternalLink, FileDown, FileText, Printer } from "lucide-react";
import { downloadExport, openInOverleaf, type ExportFormat } from "@/lib/api";
import type { TailoredResume } from "@/lib/types";
import { resumeToText } from "@/lib/resume";
import { Button, Spinner, copyText, useToast } from "./ui";

export function DownloadMenu({ getResume }: { getResume: () => TailoredResume }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const dl = async (format: ExportFormat) => {
    setBusy(format);
    try {
      await downloadExport({ format, resume: getResume() });
      toast("success", `Downloaded ${format.toUpperCase()}.`);
      setOpen(false);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const items: { format: ExportFormat; label: string; hint: string }[] = [
    { format: "pdf", label: "PDF", hint: "Best for applying" },
    { format: "docx", label: "Word (.docx)", hint: "Edit further in Word or Google Docs" },
    { format: "tex", label: "LaTeX (.tex)", hint: "Keep editing the source yourself" },
    { format: "md", label: "Markdown", hint: "For GitHub or Notion" },
    { format: "txt", label: "Plain text", hint: "For pasting into job portals" },
  ];

  return (
    <div className="relative" ref={ref}>
      <div className="flex">
        <Button variant="primary" size="sm" className="rounded-r-none" onClick={() => dl("pdf")} loading={busy === "pdf"} title="Download as PDF">
          {busy !== "pdf" && <Download className="size-3.5" />} Download
        </Button>
        <Button variant="primary" size="sm" className="rounded-l-none border-l border-white/25 px-1.5" aria-label="More download formats" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ChevronDown className="size-4" />
        </Button>
      </div>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1.5 w-64 overflow-hidden rounded-lg border border-rule bg-paper py-1 shadow-xl">
          {items.map((it) => (
            <button key={it.format} role="menuitem" onClick={() => dl(it.format)} className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-desk">
              {busy === it.format ? <Spinner className="mt-0.5" /> : it.format === "pdf" || it.format === "docx" ? <FileDown className="mt-0.5 size-4 text-muted" /> : <FileText className="mt-0.5 size-4 text-muted" />}
              <span>
                <span className="block text-sm font-medium">{it.label}</span>
                <span className="block text-xs text-muted">{it.hint}</span>
              </span>
            </button>
          ))}
          <button
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              try {
                await openInOverleaf(getResume());
              } catch (e) {
                toast("error", (e as Error).message);
              }
            }}
            className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-desk"
          >
            <ExternalLink className="mt-0.5 size-4 text-muted" />
            <span>
              <span className="block text-sm font-medium">Open in Overleaf</span>
              <span className="block text-xs text-muted">Edit and compile the LaTeX online</span>
            </span>
          </button>
          <div className="my-1 border-t border-rule-soft" />
          <button
            role="menuitem"
            onClick={async () => {
              const ok = await copyText(resumeToText(getResume()));
              toast(ok ? "success" : "error", ok ? "Resume text copied." : "Couldn't access the clipboard.");
              setOpen(false);
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-desk"
          >
            <Copy className="size-4 text-muted" /> Copy as text
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setTimeout(() => window.print(), 50);
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-desk"
          >
            <Printer className="size-4 text-muted" /> Print
          </button>
        </div>
      )}
    </div>
  );
}
