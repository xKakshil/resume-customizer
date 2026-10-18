from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotFoundError
from app.core.security import current_user
from app.models.db import Run, User, get_db

router = APIRouter(prefix="/api/history", tags=["history"])


class CoverLetterAttach(BaseModel):
    text: str = Field(max_length=10_000)


def _iso(dt: datetime) -> str:
    # SQLite drops tzinfo; values are stored in UTC, so re-attach it before serialising.
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()


def _get(db: Session, user: User, run_id: int) -> Run:
    run = db.get(Run, run_id)
    if not run or run.user_id != user.id:
        raise NotFoundError("That saved result doesn't exist.")
    return run


@router.get("")
def list_runs(limit: int = 50, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Run).where(Run.user_id == user.id).order_by(Run.created_at.desc()).limit(min(max(limit, 1), 100))).all()
    return [{"id": r.id, "title": r.title, "company": r.company, "resume_filename": r.resume_filename,
             "match_before": r.match_before, "match_after": r.match_after,
             "tone": (r.result.get("meta") or {}).get("tone"), "created_at": _iso(r.created_at)} for r in rows]


@router.get("/{run_id}")
def get_run(run_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = _get(db, user, run_id)
    return {"id": r.id, "job_description": r.job_description, "resume_text": r.resume_text,
            "resume_filename": r.resume_filename, "result": {**r.result, "id": r.id}, "created_at": _iso(r.created_at)}


@router.put("/{run_id}/cover-letter")
def attach_cover_letter(run_id: int, body: CoverLetterAttach, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = _get(db, user, run_id)
    r.result = {**r.result, "cover_letter": body.text}
    db.commit()
    return {"ok": True}


@router.delete("/{run_id}", status_code=204)
def delete_run(run_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    db.delete(_get(db, user, run_id))
    db.commit()
