FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    TECTONIC_CACHE_DIR=/home/appuser/.cache/tectonic

# DejaVu gives the PDF exporter full Unicode coverage (names with accents, ₹, “smart quotes”…).
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Tectonic (static musl build, no system libs needed): a small self-contained LaTeX engine, used to preview uploaded LaTeX resumes
# exactly. Optional — without it, LaTeX previews fall back to a style-matched PDF.
ARG TECTONIC_VERSION=0.15.0
RUN curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      | tar -xz -C /usr/local/bin tectonic || echo "tectonic not installed — LaTeX previews will use style matching"

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

RUN useradd --create-home appuser && chown -R appuser /app
USER appuser

# Warm Tectonic's package cache with what common resume templates use, so the
# first preview is fast. Failure is fine (the cache fills on first real use).
RUN mkdir -p "$TECTONIC_CACHE_DIR" && cd /tmp && printf '%s\n' \
    '\documentclass[letterpaper,11pt]{article}' \
    '\usepackage{latexsym,marvosym,verbatim,enumitem,titlesec,fancyhdr,tabularx,xcolor,lmodern,geometry,microtype}' \
    '\usepackage[empty]{fullpage}\usepackage[hidelinks]{hyperref}\usepackage[english]{babel}' \
    '\input{glyphtounicode}\begin{document}Warm\end{document}' > warm.tex \
    && (command -v tectonic >/dev/null && tectonic --untrusted warm.tex >/dev/null 2>&1 || true) && rm -f warm.*

EXPOSE 8000
# --proxy-headers so rate limiting sees the real client IP behind Render/Cloud Run.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
