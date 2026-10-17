"""Typed application errors. Every error that reaches the client has a stable
machine-readable `code` and a human-readable `message` the UI can show as-is."""

from fastapi import Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str, *, code: str | None = None, status_code: int | None = None, details: dict | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code
        self.details = details or {}

    def to_dict(self) -> dict:
        body = {"code": self.code, "message": self.message}
        if self.details:
            body["details"] = self.details
        return body


class InvalidInputError(AppError):
    status_code = 422
    code = "invalid_input"


class UnsupportedFileError(AppError):
    status_code = 415
    code = "unsupported_file"


class FileTooLargeError(AppError):
    status_code = 413
    code = "file_too_large"


class ParseError(AppError):
    status_code = 422
    code = "parse_failed"


class LLMError(AppError):
    status_code = 502
    code = "llm_unavailable"


class RateLimitedError(AppError):
    status_code = 429
    code = "rate_limited"


class AuthError(AppError):
    status_code = 401
    code = "unauthorized"


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"


async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    headers = {}
    if isinstance(exc, RateLimitedError) and "retry_after" in exc.details:
        headers["Retry-After"] = str(exc.details["retry_after"])
    return JSONResponse(status_code=exc.status_code, content={"error": exc.to_dict()}, headers=headers)
