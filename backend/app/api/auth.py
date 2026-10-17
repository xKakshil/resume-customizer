from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.errors import AppError, AuthError
from app.core.security import create_token, current_user, hash_password, verify_password
from app.models.db import User, get_db
from app.models.schemas import AuthRequest

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_out(u: User) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name}


@router.post("/register", status_code=201)
def register(body: AuthRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.check(request, "auth", 10)
    if db.scalar(select(User).where(User.email == body.email)):
        raise AppError("An account with this email already exists. Try signing in.", code="email_taken", status_code=409)
    user = User(email=body.email, name=body.name.strip(), password_hash=hash_password(body.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise AppError("An account with this email already exists. Try signing in.", code="email_taken", status_code=409) from exc
    return {"token": create_token(user.id), "user": _user_out(user)}


@router.post("/login")
def login(body: AuthRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.check(request, "auth", 10)
    user = db.scalar(select(User).where(User.email == body.email))
    if not user or not verify_password(body.password, user.password_hash):
        raise AuthError("Incorrect email or password.", code="bad_credentials")
    return {"token": create_token(user.id), "user": _user_out(user)}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return _user_out(user)
