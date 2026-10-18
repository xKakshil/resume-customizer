"""Short-lived storage of original resume files (for "Match original" exports)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete

from app.config import get_settings
from app.models.db import Upload, session


def save(data: bytes, file_type: str, filename: str) -> str:
    ttl = timedelta(hours=get_settings().upload_ttl_hours)
    uid = uuid.uuid4().hex
    with session() as db:
        db.execute(delete(Upload).where(Upload.created_at < datetime.now(timezone.utc) - ttl))
        db.add(Upload(id=uid, file_type=file_type, filename=filename[:255], data=data))
        db.commit()
    return uid


def load(uid: str) -> Upload | None:
    if not uid or len(uid) > 64:
        return None
    ttl = timedelta(hours=get_settings().upload_ttl_hours)
    with session() as db:
        up = db.get(Upload, uid)
        if not up:
            return None
        created = up.created_at if up.created_at.tzinfo else up.created_at.replace(tzinfo=timezone.utc)
        if created < datetime.now(timezone.utc) - ttl:
            db.delete(up)
            db.commit()
            return None
        db.expunge(up)
        return up
