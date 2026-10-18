"""Application settings, loaded from environment variables (and an optional .env file)."""

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Resume Customizer API"
    environment: str = "development"

    # --- LLM -----------------------------------------------------------------
    # Ordered, comma-separated provider chain. The first healthy provider wins;
    # on rate limits / 5xx / timeouts the next one is tried.
    llm_providers: str = "gemini,groq"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.8-flash"
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai"
    # Keeps "thinking" short so tokens go to the answer; set empty to use the model default.
    gemini_reasoning_effort: str = "low"
    groq_api_key: str = ""
    # Groq retired llama-3.3-70b-versatile on 2026-08-16; gpt-oss-120b is its recommended replacement.
    groq_model: str = "openai/gpt-oss-120b"
    # gpt-oss is a reasoning model: keep reasoning short so the token budget goes to the answer.
    groq_reasoning_effort: str = "low"
    groq_base_url: str = "https://api.groq.com/openai/v1"
    openai_api_key: str = ""
    openai_model: str = "gpt-4.1-mini"
    openai_base_url: str = "https://api.openai.com/v1"
    # Local, private inference via Ollama (https://ollama.com) — no API key needed.
    ollama_model: str = "llama3.1"
    ollama_base_url: str = "http://localhost:11434/v1"
    llm_timeout_seconds: float = 90.0
    llm_max_retries: int = 2
    llm_temperature: float = 0.4
    llm_max_output_tokens: int = 12000

    # --- Input limits ----------------------------------------------------------
    max_upload_mb: float = 5.0
    min_jd_chars: int = 100
    max_jd_chars: int = 20_000
    min_resume_chars: int = 200
    max_resume_chars: int = 30_000
    max_pdf_pages: int = 10
    upload_ttl_hours: int = 48

    # --- Security --------------------------------------------------------------
    cors_origins: str = "http://localhost:3000"
    # Optional regex so Vercel preview deployments work without listing each URL.
    cors_origin_regex: str = ""
    jwt_secret: str = Field(default="dev-insecure-secret-change-me")
    jwt_expire_hours: int = 24 * 7
    rate_limit_per_minute: int = 12

    # --- Storage ---------------------------------------------------------------
    database_url: str = "sqlite:///./resume_customizer.db"

    @field_validator("database_url")
    @classmethod
    def _normalise_db_url(cls, v: str) -> str:
        if not v.strip():  # blank DATABASE_URL means "use SQLite"
            return "sqlite:///./resume_customizer.db"
        # Render/Neon/Heroku hand out postgres:// URLs; SQLAlchemy wants an explicit driver.
        if v.startswith("postgres://"):
            v = "postgresql://" + v[len("postgres://") :]
        if v.startswith("postgresql://"):
            v = "postgresql+psycopg://" + v[len("postgresql://") :]
        return v

    @property
    def max_upload_bytes(self) -> int:
        return int(self.max_upload_mb * 1024 * 1024)

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]

    @property
    def provider_chain(self) -> list[str]:
        return [p.strip().lower() for p in self.llm_providers.split(",") if p.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
