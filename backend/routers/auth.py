from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

_SUPABASE_ENABLED = bool(os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_ANON_KEY"))


class AuthRequest(BaseModel):
    email: str
    password: str


@router.post("/login")
async def login(body: AuthRequest):
    if not _SUPABASE_ENABLED:
        raise HTTPException(status_code=503, detail="Auth not configured (missing SUPABASE_URL/ANON_KEY)")
    from ..services.auth import get_client
    try:
        client = get_client()
        resp = client.auth.sign_in_with_password({"email": body.email, "password": body.password})
        return {
            "access_token": resp.session.access_token,
            "token_type": "bearer",
            "user_email": resp.user.email,
        }
    except Exception as exc:
        raise HTTPException(status_code=401, detail=str(exc))


@router.post("/register")
async def register(body: AuthRequest):
    if not _SUPABASE_ENABLED:
        raise HTTPException(status_code=503, detail="Auth not configured (missing SUPABASE_URL/ANON_KEY)")
    from ..services.auth import get_client
    try:
        client = get_client()
        resp = client.auth.sign_up({"email": body.email, "password": body.password})
        if resp.session:
            return {
                "access_token": resp.session.access_token,
                "token_type": "bearer",
                "user_email": resp.user.email,
                "confirmed": True,
            }
        return {"confirmed": False, "message": "Check your email to confirm your address, then log in."}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/logout")
async def logout():
    if _SUPABASE_ENABLED:
        try:
            from ..services.auth import get_client
            get_client().auth.sign_out()
        except Exception:
            pass
    return {"message": "Logged out"}
