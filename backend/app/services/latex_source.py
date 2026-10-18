"""LaTeX resumes as *input*: extract readable text, and write tailored bullets
back into the user's own .tex so their template, macros and spacing survive.

The converter is a small brace-aware walker, not a TeX engine. It understands
the patterns real resume templates use (Jake's Resume, AltaCV-style macros,
moderncv-ish `\\cvitem`, plain `itemize`): sections, `\\item`, `\\resumeItem{}`,
multi-argument heading macros, `\\href`, tabular rows and math-mode separators.

Bullet *spans* are recorded with their character offsets in the original
source, which makes the write-back exact: only the bullet text inside those
spans is replaced; everything else in the file is byte-for-byte unchanged.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

from app.services.latex import tex as escape

_DROP_WITH_ARGS = {
    "vspace", "vspace*", "hspace", "hspace*", "vskip", "hskip", "setlength", "addtolength", "label", "includegraphics",
    "pagestyle", "thispagestyle", "fontsize", "color", "definecolor", "newcommand", "renewcommand", "titleformat",
    "titlespacing", "titlespacing*", "pdfgentounicode", "input", "setmainfont", "setsansfont", "linespread",
    "raggedright", "phantom", "rule", "colorbox", "fcolorbox", "faIcon", "includepdf", "newgeometry",
}
_ARGLESS_TEXT = {
    "hfill": " ", "quad": " ", "qquad": " ", "cdot": "·", "textbar": "|", "textbullet": "•", "bullet": "•",
    "LaTeX": "LaTeX", "TeX": "TeX", "ldots": "…", "dots": "…", "textendash": "–", "textemdash": "—",
    "newline": "\n", "par": "\n", "linebreak": "\n", "sim": "~", "textasciitilde": "~", "space": " ",
    "times": "×", "rightarrow": "→", "to": "→", "textperiodcentered": "·", "vert": "|", "mid": "|",
}
_ONE_ARG = {
    "textbf", "textit", "emph", "underline", "textsc", "texttt", "textrm", "textsf", "textmd", "textup", "textsl",
    "mbox", "hbox", "fbox", "makebox", "uppercase", "MakeUppercase", "MakeLowercase", "small", "footnotesize",
    "scriptsize", "tiny", "large", "Large", "LARGE", "huge", "Huge", "normalsize", "bfseries", "itshape", "scshape",
    "textnormal", "text", "mathrm", "mathbf", "vcenter", "centerline", "noindent",
}
_ENV_EXTRA_ARGS = {"tabular": 1, "tabular*": 2, "tabularx": 2, "minipage": 1, "multicols": 1, "longtable": 1, "array": 1}
_SECTION = {"section", "section*", "subsection", "subsection*", "cvsection", "sectiontitle"}
_STOP_ITEM = re.compile(r"\\item\b|\\end\{|\\begin\{|\\resume[A-Za-z]*|\\section|\\cvitem")
_SUMMARY_HEAD = re.compile(r"\\section\*?\s*\{\s*(?:professional\s+)?(summary|profile|objective|career objective|about me)\s*\}", re.I)
_BANNED = re.compile(r"\\(?:include|openin|read\b|write|immediate|catcode|csname|directlua|special|pdfobj|pdffiledump|"
                     r"pdffilemoddate|pdffilesize|IfFileExists|InputIfFileExists|lstinputlisting|verbatiminput|"
                     r"includegraphics|usetikzlibrary|ExplSyntaxOn|scantokens|endlinechar|everyeof)|\^\^")


@dataclass
class Span:
    start: int
    end: int
    plain: str
    kind: str  # "item" | "macro"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def blank_comments(src: str) -> str:
    """Replace comments with spaces so character offsets stay identical."""
    return re.sub(r"(?<!\\)%[^\n]*", lambda m: " " * len(m.group(0)), src)


def _match_brace(s: str, i: int, open_="{", close="}") -> int:
    depth = 0
    j = i
    while j < len(s):
        ch = s[j]
        if ch == "\\":
            j += 2
            continue
        if ch == open_:
            depth += 1
        elif ch == close:
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return len(s) - 1


def _read_args(s: str, i: int, max_args: int | None = None) -> tuple[list[tuple[int, int]], int]:
    """Read [opt] and {arg} groups after a macro. Groups may be separated by
    whitespace/newlines (multi-line \\resumeSubheading), but not by a blank line."""
    groups: list[tuple[int, int]] = []
    j = i
    while max_args is None or len(groups) < max_args:
        k = j
        while k < len(s) and s[k] in " \t\n":
            k += 1
        if "\n\n" in s[j:k]:
            break
        if k < len(s) and s[k] == "[" and not groups:
            j = _match_brace(s, k, "[", "]") + 1
            continue
        if k < len(s) and s[k] == "{":
            end = _match_brace(s, k)
            groups.append((k + 1, end))
            j = end + 1
            continue
        break
    return groups, j


def _math(inner: str) -> str:
    inner = inner.strip()
    for k, v in _ARGLESS_TEXT.items():
        inner = inner.replace("\\" + k, v)
    return re.sub(r"\\[A-Za-z]+", "", inner).replace("{", "").replace("}", "")


def body_bounds(src: str) -> tuple[int, int]:
    b = src.find("\\begin{document}")
    e = src.rfind("\\end{document}")
    start = b + len("\\begin{document}") if b >= 0 else 0
    return start, (e if e > start else len(src))


# --------------------------------------------------------------------------- #
# TeX → plain text
# --------------------------------------------------------------------------- #
def convert(s: str, links: list[str] | None = None) -> str:
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\":
            m = re.match(r"\\([A-Za-z@]+\*?|.)", s[i:])
            if not m:
                i += 1
                continue
            name = m.group(1)
            i += len(m.group(0))
            if len(name) == 1 and not name.isalpha():
                if name == "\\":
                    out.append("\n")
                    if i < n and s[i] == "[":
                        i = _match_brace(s, i, "[", "]") + 1
                elif name in "&%$#_{}":
                    out.append(name)
                elif name in " ,;:!":
                    out.append(" ")
                continue
            if name in ("begin", "end"):
                groups, j = _read_args(s, i, 1)
                env = s[groups[0][0]:groups[0][1]].strip() if groups else ""
                i = j
                if name == "begin":
                    k = i
                    while k < n and s[k] in " \t":
                        k += 1
                    if k < n and s[k] == "[":
                        i = _match_brace(s, k, "[", "]") + 1
                    if env in _ENV_EXTRA_ARGS:
                        _, i = _read_args(s, i, _ENV_EXTRA_ARGS[env])
                out.append("\n")
                continue
            if name == "item":
                if i < n and s[i] == "[":
                    i = _match_brace(s, i, "[", "]") + 1
                out.append("\n• ")
                continue
            if name in _ARGLESS_TEXT and not (i < n and s[i] == "{"):
                out.append(_ARGLESS_TEXT[name])
                continue
            groups, j = _read_args(s, i, 1 if name in _ONE_ARG else None)
            args = [s[a:b] for a, b in groups]
            i = j
            low = name.lower()
            if name in _DROP_WITH_ARGS or low in _DROP_WITH_ARGS:
                continue
            if name in _SECTION:
                out.append("\n\n" + convert(args[-1], links).strip().upper() + "\n" if args else "\n")
            elif name == "href" and len(args) >= 2:
                if links is not None:
                    links.append(args[0].strip())
                out.append(convert(args[1], links))
            elif name == "url" and args:
                if links is not None:
                    links.append(args[0].strip())
                out.append(args[0])
            elif "item" in low and not low.endswith(("start", "end")) and args:
                out.append("\n• " + convert(args[-1], links).strip() + "\n")
            elif len(args) >= 2:
                parts = [convert(a, links).strip() for a in args]
                out.append("\n" + " | ".join(p for p in parts if p) + "\n")
            elif args:
                out.append(convert(args[0], links))
            continue
        if c == "{":
            j = _match_brace(s, i)
            out.append(convert(s[i + 1:j], links))
            i = j + 1
            continue
        if c == "}":
            i += 1
            continue
        if c == "$":
            j = s.find("$", i + 1)
            j = j if j > i else n
            out.append(_math(s[i + 1:j]))
            i = j + 1
            continue
        if c == "%":
            j = s.find("\n", i)
            i = j if j >= 0 else n
            continue
        if c == "~":
            out.append(" ")
        elif c == "&":
            out.append(" | ")
        else:
            out.append(c)
        i += 1
    text = "".join(out)
    text = text.replace("---", "—").replace("--", "–").replace("``", "\u201c").replace("''", "\u201d")
    return text


def tidy(text: str) -> str:
    lines: list[str] = []
    for raw in text.split("\n"):
        line = re.sub(r"[ \t]+", " ", raw).strip()
        line = re.sub(r"^(\|\s*)+|(\s*\|)+$", "", line).strip()
        line = re.sub(r"(\s*\|\s*){2,}", " | ", line)
        line = re.sub(r"\s+([,.;:])", r"\1", line)
        if line == "•" or not line:
            continue
        if lines and lines[-1] == "•":
            lines[-1] = "• " + line
            continue
        lines.append(line)
    out: list[str] = []
    for line in lines:  # a blank line only before section headings
        if out and len(line) < 45 and line.isupper() and any(ch.isalpha() for ch in line):
            out.append("")
        out.append(line)
    return "\n".join(out).strip()


def tex_to_text(src: str) -> tuple[str, list[str]]:
    clean = blank_comments(src)
    a, b = body_bounds(clean)
    links: list[str] = []
    return tidy(convert(clean[a:b], links)), links


# --------------------------------------------------------------------------- #
# Bullet spans + write-back
# --------------------------------------------------------------------------- #
def _norm(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", t.lower())


def bullet_spans(src: str) -> list[Span]:
    clean = blank_comments(src)
    a, b = body_bounds(clean)
    spans: list[Span] = []
    for m in re.finditer(r"\\([A-Za-z]*[Ii]tem[A-Za-z]*)\b", clean[a:b]):
        name = m.group(1)
        pos = a + m.end()
        if name == "item":
            start = pos
            if start < b and clean[start] == "[":
                start = _match_brace(clean, start, "[", "]") + 1
            nxt = _STOP_ITEM.search(clean, start, b)
            end = nxt.start() if nxt else b
            while end > start and clean[end - 1] in " \t\n":
                end -= 1
            plain = tidy(convert(clean[start:end]))
            if plain:
                spans.append(Span(start, end, plain, "item"))
        elif not name.lower().endswith(("start", "end")):
            groups, _ = _read_args(clean, pos)
            if groups:
                s0, e0 = groups[-1]
                plain = tidy(convert(clean[s0:e0]))
                if plain:
                    spans.append(Span(s0, e0, plain, "macro"))
    return spans


def _best_span(original: str, spans: list[Span], used: set[int]) -> int | None:
    key = _norm(original)
    if not key:
        return None
    best, best_ratio = None, 0.0
    for i, sp in enumerate(spans):
        if i in used:
            continue
        cand = _norm(sp.plain)
        if cand == key:
            return i
        ratio = SequenceMatcher(None, key, cand).ratio()
        if ratio > best_ratio:
            best, best_ratio = i, ratio
    return best if best_ratio >= 0.85 else None


def apply_to_tex(src: str, resume, show_summary: bool) -> tuple[str, dict]:
    """Return (new_source, report). `resume` is a TailoredResume."""
    spans = bullet_spans(src)
    used: set[int] = set()
    replacements: list[tuple[int, int, str]] = []
    matched = unmatched = 0
    for item in [*resume.experience, *resume.projects]:
        slots, texts = [], []
        for bl in item.bullets:
            idx = _best_span(bl.original, spans, used)
            if idx is None:
                unmatched += bool(bl.original.strip())
                continue
            used.add(idx)
            slots.append(idx)
            texts.append((bl.tailored or bl.original, bl.original, idx))
        # Keep the file's slots in place and fill them in the tailored order.
        for slot, (text, original, src_idx) in zip(sorted(slots), texts):
            sp = spans[slot]
            if text.strip() == original.strip() and slot == src_idx:
                continue  # unchanged — keep the source (and any inline formatting) exactly
            body = escape(text) if text.strip() != original.strip() else src[spans[src_idx].start:spans[src_idx].end].strip()
            replacements.append((sp.start, sp.end, (" " + body) if sp.kind == "item" else body))
            matched += 1

    out = src
    for start, end, text in sorted(replacements, key=lambda r: -r[0]):
        out = out[:start] + text + out[end:]

    out, summary_action = _apply_summary(out, resume, show_summary)
    return out, {"bullets_replaced": matched, "bullets_unmatched": unmatched, "summary": summary_action}


def _apply_summary(src: str, resume, show_summary: bool) -> tuple[str, str]:
    clean = blank_comments(src)
    a, b = body_bounds(clean)
    m = _SUMMARY_HEAD.search(clean, a, b)
    text = (resume.summary.tailored or resume.summary.original or "").strip()
    if m:
        nxt = re.compile(r"\\section\*?\s*\{|\\end\{document\}").search(clean, m.end())
        end = nxt.start() if nxt else b
        if not show_summary:
            return src[:m.start()] + src[end:], "removed"
        if text:
            return src[:m.end()] + "\n" + escape(text) + "\n\n" + src[end:], "replaced"
        return src, "kept"
    if show_summary and text:
        first = re.compile(r"\\section\*?\s*\{").search(clean, a, b)
        at = first.start() if first else b
        return src[:at] + "\\section{Summary}\n" + escape(text) + "\n\n" + src[at:], "added"
    return src, "none"


# --------------------------------------------------------------------------- #
# Style hints from the preamble
# --------------------------------------------------------------------------- #
def tex_style(src: str) -> dict:
    pre = src[: src.find("\\begin{document}")] if "\\begin{document}" in src else src
    style: dict = {"detected": True, "source": "tex"}
    m = re.search(r"\\documentclass\[([^\]]*)\]", pre)
    opts = m.group(1) if m else ""
    if (pt := re.search(r"(\d{1,2}(?:\.\d)?)pt", opts)):
        style["font_size"] = float(pt.group(1))
    style["page_size"] = "Letter" if "letterpaper" in opts or ("a4paper" not in opts and "a4" not in pre) else "A4"
    margins = {"top": 1.0, "bottom": 1.0, "left": 1.0, "right": 1.0}
    if (g := re.search(r"\\usepackage\[([^\]]*)\]\{geometry\}", pre)) or (g := re.search(r"\\geometry\{([^}]*)\}", pre)):
        for k, v, unit in re.findall(r"(margin|top|bottom|left|right|hmargin|vmargin)\s*=\s*([\d.]+)\s*(in|cm|mm|pt)", g.group(1)):
            val = float(v) / {"in": 1, "cm": 2.54, "mm": 25.4, "pt": 72.27}[unit]
            keys = {"margin": margins.keys(), "hmargin": ("left", "right"), "vmargin": ("top", "bottom")}.get(k, (k,))
            for key in keys:
                margins[key] = val
    for what, v, unit in re.findall(r"\\addtolength\{\\(oddsidemargin|topmargin)\}\{(-?[\d.]+)\s*(in|cm|pt)\}", pre):
        val = float(v) / {"in": 1, "cm": 2.54, "pt": 72.27}[unit]
        if what == "oddsidemargin":
            margins["left"] = margins["right"] = max(0.25, 1.0 + val)
        else:
            margins["top"] = margins["bottom"] = max(0.25, 1.0 + val)
    style["margins"] = {k: round(min(2.0, max(0.25, v)), 2) for k, v in margins.items()}
    sans = re.search(r"\\familydefault\}\{\\sfdefault|\{helvet\}|sourcesanspro|\{roboto|\{lato\}|\{opensans\}|\{arev\}|FiraSans", pre)
    style["font_family"] = "sans" if sans else "serif"
    style["heading_case"] = "smallcaps" if "\\scshape" in pre else "upper" if "\\MakeUppercase" in pre or "\\uppercase" in pre else "title"
    style["heading_rule"] = "\\titlerule" in pre or "\\hrule" in pre
    body = src[src.find("\\begin{document}"):][:1500]
    style["header_align"] = "center" if "\\begin{center}" in body or "\\centering" in body else "left"
    return style


# --------------------------------------------------------------------------- #
# Compile (sandboxed) — used for exact PDF previews of LaTeX templates
# --------------------------------------------------------------------------- #
def latex_engine() -> str | None:
    path = os.environ.get("PATH", "") + ":/opt/homebrew/bin:/Library/TeX/texbin"
    for exe in ("tectonic", "pdflatex"):
        if shutil.which(exe, path=path):
            return exe
    return None


def compile_tex(src: str, timeout: float = 40.0, trusted: bool = False) -> bytes | None:
    """Compile untrusted LaTeX safely, or return None.

    Defence in depth: refuse sources using file/shell primitives (or ^^ escapes
    that could build them), allow only `\\input{glyphtounicode}`, run in an empty
    temp dir with kpathsea set to *paranoid* file access, no shell escape, and a
    hard timeout."""
    engine = latex_engine()
    if not engine:
        return None
    if not trusted:  # user-supplied source; our own generated .tex only contains escaped text
        probe = re.sub(r"\\input\{glyphtounicode\}", "", blank_comments(src))
        if _BANNED.search(probe) or re.search(r"\\input\b", probe):
            return None
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "resume.tex"
        path.write_text(src, encoding="utf-8")
        cache = os.environ.get("TECTONIC_CACHE_DIR", str(Path(tempfile.gettempdir()) / "tectonic-cache"))
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/Library/TeX/texbin", "HOME": d, "TEXMFOUTPUT": d,
               "openin_any": "p", "openout_any": "p", "shell_escape": "f",
               # Tectonic fetches packages on first use; keep its cache between compiles.
               "TECTONIC_CACHE_DIR": cache, "XDG_CACHE_HOME": cache}
        if engine == "tectonic":
            cmd = ["tectonic", "--untrusted", "--outdir", d, str(path)]
        else:
            cmd = ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "-output-directory", d, str(path)]
        try:
            subprocess.run(cmd, cwd=d, env=env, capture_output=True, timeout=timeout, check=False)
        except (subprocess.TimeoutExpired, OSError):
            return None
        pdf = Path(d) / "resume.pdf"
        return pdf.read_bytes() if pdf.exists() and pdf.stat().st_size > 0 else None
