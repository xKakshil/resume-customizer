"""Import a job description from a URL.

Safety first: fetching arbitrary URLs from a server is a classic SSRF vector,
so every hop (including redirects) is resolved and rejected if it points at a
private, loopback, link-local or otherwise non-public address. Responses are
size- and time-limited and must be HTML or plain text.

Extraction prefers the schema.org `JobPosting` JSON-LD that most job boards
(Greenhouse, Lever, Workday, Naukri, LinkedIn public pages, …) embed for Google
for Jobs; it falls back to the page's main readable text.
"""

from __future__ import annotations

import asyncio
import html as html_lib
import ipaddress
import json
import re
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx

from app.core.errors import InvalidInputError
from app.services.jd import clean_jd

MAX_BYTES = 2_000_000
TIMEOUT = httpx.Timeout(12.0, connect=6.0)
MAX_REDIRECTS = 4
LOGIN_WALLS = ("linkedin.com/login", "linkedin.com/authwall", "accounts.google.com", "/signin", "/login")


class FetchError(InvalidInputError):
    code = "jd_fetch_failed"


# --------------------------------------------------------------------------- #
# SSRF protection
# --------------------------------------------------------------------------- #
def _is_public_ip(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    return not (addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast
                or addr.is_reserved or addr.is_unspecified or (addr.version == 6 and addr.ipv4_mapped
                                                                and not _is_public_ip(str(addr.ipv4_mapped))))


async def assert_public_url(url: str) -> None:
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise FetchError("Enter a full web address starting with http:// or https://.")
    if p.port not in (None, 80, 443):
        raise FetchError("That address uses an unusual port and can't be fetched.")
    host = p.hostname
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise FetchError("That website couldn't be found. Check the link.") from exc
    if not infos or not all(_is_public_ip(info[4][0]) for info in infos):
        raise FetchError("That address isn't a public website.")


# --------------------------------------------------------------------------- #
# Extraction
# --------------------------------------------------------------------------- #
class _TextExtractor(HTMLParser):
    """Collects visible text, skipping chrome (nav/header/footer/scripts) and keeping line structure."""

    SKIP = {"script", "style", "noscript", "svg", "nav", "header", "footer", "form", "button", "iframe", "template"}
    BLOCK = {"p", "div", "li", "br", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "ul", "ol"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0
        self.jsonld: list[str] = []
        self._in_jsonld = False
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script" and (a.get("type") or "").lower() == "application/ld+json":
            self._in_jsonld = True
            self.jsonld.append("")
            return
        if tag == "title":
            self._in_title = True
        if tag in self.SKIP:
            self.skip_depth += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")
        if tag == "li" and not self.skip_depth:
            self.parts.append("- ")

    def handle_endtag(self, tag):
        if tag == "script" and self._in_jsonld:
            self._in_jsonld = False
            return
        if tag == "title":
            self._in_title = False
        if tag in self.SKIP and self.skip_depth:
            self.skip_depth -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_jsonld:
            self.jsonld[-1] += data
        elif self._in_title:
            self.title += data
        elif not self.skip_depth:
            self.parts.append(data)


def html_to_text(fragment: str) -> str:
    ex = _TextExtractor()
    ex.feed(fragment)
    text = "".join(ex.parts)
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _find_job_posting(node) -> dict | None:
    if isinstance(node, dict):
        t = node.get("@type")
        if t == "JobPosting" or (isinstance(t, list) and "JobPosting" in t):
            return node
        for v in node.values():
            if found := _find_job_posting(v):
                return found
    elif isinstance(node, list):
        for v in node:
            if found := _find_job_posting(v):
                return found
    return None


def extract_job(page_html: str) -> dict:
    """Return {title, company, text, source} from a job page's HTML."""
    ex = _TextExtractor()
    ex.feed(page_html)
    for raw in ex.jsonld:
        try:
            posting = _find_job_posting(json.loads(raw.strip()))
        except (json.JSONDecodeError, ValueError):
            continue
        if posting and posting.get("description"):
            org = posting.get("hiringOrganization") or {}
            company = org.get("name", "") if isinstance(org, dict) else str(org)
            title = html_lib.unescape(str(posting.get("title", ""))).strip()
            body = html_to_text(html_lib.unescape(str(posting["description"])))
            header = " — ".join(x for x in (title, company) if x)
            return {"title": title, "company": company, "text": f"{header}\n\n{body}".strip(), "source": "structured"}

    # Fallback: visible text of <main>/<article> if present, else the whole page.
    m = re.search(r"<(main|article)\b[^>]*>(.*?)</\1>", page_html, re.S | re.I)
    text = html_to_text(m.group(2) if m and len(m.group(2)) > 500 else page_html)
    return {"title": html_lib.unescape(ex.title).strip(), "company": "", "text": text, "source": "page"}


# --------------------------------------------------------------------------- #
# Fetch
# --------------------------------------------------------------------------- #
async def fetch_job_description(url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> dict:
    url = url.strip()
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    headers = {"User-Agent": "Mozilla/5.0 (compatible; TailorResumeBot/1.0; +https://github.com)",
               "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9"}
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False, headers=headers, transport=transport) as client:
        for _ in range(MAX_REDIRECTS + 1):
            await assert_public_url(url)
            try:
                async with client.stream("GET", url) as resp:
                    if resp.is_redirect:
                        url = urljoin(url, resp.headers.get("location", ""))
                        continue
                    if resp.status_code in (401, 403, 429, 999):
                        raise FetchError("That site blocked automatic access (it may need you to sign in). Copy the job text and paste it instead.")
                    if resp.status_code >= 400:
                        raise FetchError(f"The page returned an error ({resp.status_code}). Check the link, or paste the job text instead.")
                    ctype = resp.headers.get("content-type", "").lower()
                    if ctype and not any(t in ctype for t in ("text/html", "application/xhtml", "text/plain")):
                        raise FetchError("That link isn't a web page. Paste the job description text instead.")
                    chunks, size = [], 0
                    async for chunk in resp.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise FetchError("That page is too large to import. Paste the job text instead.")
                        chunks.append(chunk)
                    body = b"".join(chunks).decode(resp.encoding or "utf-8", errors="replace")
                    final_url = str(resp.url)
                    break
            except httpx.TimeoutException as exc:
                raise FetchError("The site took too long to respond. Paste the job text instead.") from exc
            except httpx.HTTPError as exc:
                raise FetchError("Couldn't connect to that site. Check the link, or paste the job text instead.") from exc
        else:
            raise FetchError("That link redirected too many times.")

    if any(w in final_url.lower() for w in LOGIN_WALLS):
        raise FetchError("That page needs you to sign in, so it can't be read automatically. Copy the job text and paste it instead.")

    job = extract_job(body) if "html" in (ctype or "html") else {"title": "", "company": "", "text": body, "source": "page"}
    text, removed = clean_jd(job["text"])
    if len(text) < 200:
        raise FetchError("Couldn't find the job description on that page — it may load with JavaScript or need sign-in. Paste the job text instead.")
    return {"job_description": text[:20_000], "title": job["title"], "company": job["company"],
            "source": job["source"], "url": final_url, "removed_lines": removed}
