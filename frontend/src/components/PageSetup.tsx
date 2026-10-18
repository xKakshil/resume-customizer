"use client";

import { Check, RotateCcw } from "lucide-react";
import type { LayoutSettings, Margins, ParsedResume, TemplateId } from "@/lib/types";
import { applyTemplate, originalMode, PRESETS } from "@/lib/layout";
import { styleSummary } from "./InputPanel";
import { cx } from "./ui";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[12.5px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11.5px] text-muted">{hint}</span>}
    </label>
  );
}

function Num({ value, onChange, min, max, step, unit, label }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number; unit: string; label: string }) {
  return (
    <div className="flex h-9 items-center rounded-md border border-rule bg-paper focus-within:border-blue">
      <input
        type="number"
        aria-label={label}
        value={Number(value.toFixed(2))}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(Math.round(Math.min(max, Math.max(min, v)) * 100) / 100);
        }}
        className="h-full w-full min-w-0 bg-transparent px-2 text-sm tabular-nums outline-none"
      />
      <span className="pr-2 text-xs text-muted">{unit}</span>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex rounded-md bg-desk-2 p-0.5" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={cx("flex-1 rounded px-2 py-1 text-[12.5px]", value === v ? "bg-paper font-medium shadow-sm" : "text-muted hover:text-ink")}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-[var(--blue)]" />
      <span>
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-[11.5px] text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function PageSetup({ layout, onChange, parsed }: { layout: LayoutSettings; onChange: (l: LayoutSettings) => void; parsed: ParsedResume | null }) {
  // Any manual tweak keeps the chosen template label, except "original", which then
  // still edits the user's DOCX/LaTeX in place but uses the tweaked values for the PDF.
  const set = <K extends keyof LayoutSettings>(k: K, v: LayoutSettings[K]) => onChange({ ...layout, [k]: v });
  const setMargin = (side: keyof Margins, v: number) => onChange({ ...layout, margins: { ...layout.margins, [side]: v } });
  const orig = originalMode(parsed);
  const m = layout.margins;
  const allSame = m.top === m.bottom && m.top === m.left && m.top === m.right;

  const templates: { id: TemplateId; label: string; hint: string; disabled?: boolean }[] = [
    { id: "original", label: "Match original", hint: orig.available ? (parsed?.style?.detected ? styleSummary(parsed.style) : orig.hint) : orig.hint, disabled: !orig.available },
    ...(Object.entries(PRESETS) as [Exclude<TemplateId, "original">, (typeof PRESETS)["classic"]][]).map(([id, p]) => ({ id, label: p.label, hint: p.hint })),
  ];

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 font-medium">Template</h3>
        <div className="grid grid-cols-3 gap-2">
          {templates.map((t) => {
            const on = layout.template === t.id;
            return (
              <button
                key={t.id}
                type="button"
                disabled={t.disabled}
                onClick={() => onChange(applyTemplate(t.id, layout, parsed))}
                aria-pressed={on}
                className={cx(
                  "relative rounded-lg border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  on ? "border-blue bg-blue-wash/60" : "border-rule bg-paper hover:border-ink-2",
                  t.id === "original" && "col-span-3",
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {t.label}
                  {t.id === "original" && orig.exact && <span className="rounded bg-green-wash px-1 text-[10.5px] font-medium text-green">exact {orig.exact}</span>}
                  {on && <Check className="ml-auto size-3.5 text-blue" />}
                </span>
                <span className="block text-[11.5px] leading-snug text-muted">{t.hint}</span>
              </button>
            );
          })}
        </div>
        {layout.template === "original" && orig.available && <p className="mt-1.5 text-[11.5px] text-muted">{orig.hint}</p>}
      </section>

      <section className="space-y-3">
        <h3 className="font-medium">Page</h3>
        <Field label="Paper size">
          <Seg label="Paper size" value={layout.page_size} options={[["A4", "A4"], ["Letter", "US Letter"]]} onChange={(v) => set("page_size", v)} />
        </Field>
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[12.5px] font-medium text-ink-2">Margins (inches)</span>
            {!allSame && (
              <button type="button" onClick={() => onChange({ ...layout, margins: { top: m.left, bottom: m.left, left: m.left, right: m.left } })} className="text-[11.5px] text-blue hover:underline">
                Make all {m.left}″
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(["top", "bottom", "left", "right"] as const).map((side) => (
              <Field key={side} label={side[0].toUpperCase() + side.slice(1)}>
                <Num label={`${side} margin`} value={m[side]} onChange={(v) => setMargin(side, v)} min={0.2} max={2} step={0.05} unit="in" />
              </Field>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="font-medium">Type</h3>
        <Field label="Font">
          <Seg label="Font" value={layout.font_family} options={[["sans", "Sans-serif"], ["serif", "Serif"]]} onChange={(v) => set("font_family", v)} />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Body">
            <Num label="Body size" value={layout.font_size} onChange={(v) => set("font_size", v)} min={8} max={13} step={0.5} unit="pt" />
          </Field>
          <Field label="Headings">
            <Num label="Heading size" value={layout.heading_size} onChange={(v) => set("heading_size", v)} min={8} max={18} step={0.5} unit="pt" />
          </Field>
          <Field label="Name">
            <Num label="Name size" value={layout.name_size} onChange={(v) => set("name_size", v)} min={12} max={32} step={1} unit="pt" />
          </Field>
        </div>
        <Field label={`Line spacing · ${layout.line_spacing.toFixed(2)}`}>
          <input type="range" min={1} max={1.8} step={0.05} value={layout.line_spacing} onChange={(e) => set("line_spacing", parseFloat(e.target.value))} className="w-full accent-[var(--blue)]" aria-label="Line spacing" />
        </Field>
      </section>

      <section className="space-y-3">
        <h3 className="font-medium">Style</h3>
        <Field label="Section headings">
          <Seg label="Heading case" value={layout.heading_case} options={[["upper", "UPPERCASE"], ["smallcaps", "Small caps"], ["title", "Title case"]]} onChange={(v) => set("heading_case", v)} />
        </Field>
        <Field label="Name & contact">
          <Seg label="Header alignment" value={layout.header_align} options={[["center", "Centred"], ["left", "Left"]]} onChange={(v) => set("header_align", v)} />
        </Field>
        <div className="flex items-center gap-4">
          <Toggle checked={layout.heading_rule} onChange={(v) => set("heading_rule", v)} label="Line under headings" />
          <label className="ml-auto flex items-center gap-2 text-sm">
            Accent
            <input type="color" value={layout.accent} onChange={(e) => set("accent", e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-rule bg-paper" aria-label="Accent colour" />
          </label>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="font-medium">Content</h3>
        <Toggle checked={layout.show_summary} onChange={(v) => set("show_summary", v)} label="Show summary" hint="Off by default. Turn on to include the summary in previews and downloads." />
        <Toggle checked={layout.one_page} onChange={(v) => set("one_page", v)} label="Fit to one page when close" hint="Tightens spacing slightly if the PDF just spills onto a second page." />
      </section>

      <button type="button" onClick={() => onChange(applyTemplate(layout.template, layout, parsed))} className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
        <RotateCcw className="size-3.5" /> Reset to {layout.template === "original" ? "detected style" : `${PRESETS[layout.template].label} defaults`}
      </button>
    </div>
  );
}
