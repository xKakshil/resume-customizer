import { Fragment, useMemo } from "react";

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build one regex for all terms, longest first, with symbol-aware word boundaries (C++, Node.js). */
export function useTermsRegex(terms: string[]): RegExp | null {
  const key = terms.join("\u0001");
  return useMemo(() => {
    const uniq = Array.from(new Set(terms.map((t) => t.trim()).filter((t) => t.length > 1))).sort((a, b) => b.length - a.length);
    if (!uniq.length) return null;
    return new RegExp(`(?<![\\w.+#])(${uniq.map(escapeRe).join("|")})(?![\\w+#])`, "gi");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function Highlight({ text, re }: { text: string; re: RegExp | null }) {
  if (!re || !text) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (!m[0]) continue;
    if (i > last) parts.push(<Fragment key={last}>{text.slice(last, i)}</Fragment>);
    parts.push(
      <mark key={i} className="hl">
        {m[0]}
      </mark>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) parts.push(<Fragment key={last}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
