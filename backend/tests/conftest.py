import os
import tempfile

_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ.update({
    "ENVIRONMENT": "test",
    "LLM_PROVIDERS": "mock",
    "DATABASE_URL": f"sqlite:///{_db.name}",
    "RATE_LIMIT_PER_MINUTE": "1000",
    "JWT_SECRET": "test-secret-test-secret-test-secret",
    "GEMINI_API_KEY": "",
    "GROQ_API_KEY": "",
})

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.core import rate_limit  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    rate_limit.reset()
    yield
