"""FastAPI application factory."""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.api import auth, chat, cover_letter, export, history, resume
from app.config import get_settings
from app.core.errors import AppError, app_error_handler
from app.models.db import init_db
from app.services.llm.factory import get_chain

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")
VERSION = "1.0.0"


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    chain = get_chain()
    if chain.providers:
        log.info("LLM providers: %s", ", ".join(f"{p.name}:{p.model}" for p in chain.providers))
    else:
        log.warning("No LLM provider configured — set GEMINI_API_KEY and/or GROQ_API_KEY (or LLM_PROVIDERS=mock).")
    yield


class CatchAllMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        started = False

        async def _send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, _send)
        except Exception:
            log.exception("unhandled error")
            if started:
                raise
            resp = JSONResponse(status_code=500, content={"error": {"code": "internal_error",
                                "message": "Something went wrong on our side. Please try again."}})
            await resp(scope, receive, send)


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title=s.app_name, version=VERSION, lifespan=lifespan,
                  description="Tailor a resume to a job description with an LLM — with truthfulness guardrails, "
                              "keyword match & ATS scoring, diffs, cover letters and exports.")

    # Inner-most: turn unexpected exceptions into JSON 500s *inside* CORS, so the
    # browser still receives CORS headers and the UI can show a friendly message.
    app.add_middleware(CatchAllMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origin_list,
        allow_origin_regex=s.cors_origin_regex or None,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=["Content-Disposition", "X-Render-Mode", "X-Render-Note"],
        max_age=600,
    )
    app.add_middleware(GZipMiddleware, minimum_size=2048)

    app.add_exception_handler(AppError, app_error_handler)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        field = ".".join(str(x) for x in first.get("loc", [])[1:]) or "request"
        msg = str(first.get("msg", "Invalid request")).removeprefix("Value error, ")
        return JSONResponse(status_code=422, content={"error": {"code": "invalid_input", "message": f"{msg} ({field})" if field != "request" else msg}})

    for r in (resume.router, chat.router, cover_letter.router, export.router, auth.router, history.router):
        app.include_router(r)

    started = time.monotonic()

    @app.api_route("/api/ping", methods=["GET", "HEAD"], tags=["meta"],
                   summary="Cheap liveness check for uptime monitors and keep-alive pings (no database, no AI call)")
    async def ping():
        return JSONResponse({"ok": True, "uptime_s": int(time.monotonic() - started)}, headers={"Cache-Control": "no-store"})

    @app.get("/api/health", tags=["meta"])
    async def health():
        chain = get_chain()
        return {"status": "ok", "version": VERSION,
                "llm": [{"provider": p.name, "model": p.model} for p in chain.providers],
                "limits": {"max_upload_mb": s.max_upload_mb, "min_jd_chars": s.min_jd_chars, "max_jd_chars": s.max_jd_chars}}

    @app.get("/", include_in_schema=False)
    async def root():
        return {"name": s.app_name, "docs": "/docs", "health": "/api/health", "ping": "/api/ping"}

    return app


app = create_app()
