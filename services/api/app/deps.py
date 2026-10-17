"""FastAPI dependencies: JWT auth, role gates, HMAC verification for internal endpoints."""
from __future__ import annotations

import jwt
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import User
from .security import ROLE_RANK, HmacError, decode_token, verify_hmac


async def current_user(request: Request, authorization: str | None = Header(default=None), session: AsyncSession = Depends(get_session)) -> User:
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:]
    token = token or request.query_params.get("token")
    if not token:
        raise HTTPException(401, "missing bearer token")
    try:
        claims = decode_token(token)
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"invalid token: {e}") from e
    user = await session.get(User, claims["sub"])
    if user is None or not user.active or user.tenant_id != claims.get("tid"):
        raise HTTPException(401, "user not found")
    # end the read transaction now: endpoints that open their own session_scope (approvals, business views) must not
    # wait on this one (SQLite takes the write lock at BEGIN; on Postgres it avoids an idle-in-transaction connection)
    session.expunge(user)
    await session.rollback()
    return user


def require_role(min_role: str):
    async def dep(user: User = Depends(current_user)) -> User:
        if ROLE_RANK.get(user.role, -1) < ROLE_RANK[min_role]:
            raise HTTPException(403, f"requires role >= {min_role}")
        return user

    return dep


async def internal_body(request: Request) -> bytes:
    body = await request.body()
    try:
        verify_hmac(body, request.headers.get("X-RG-Signature"), request.headers.get("X-RG-Timestamp"))
    except HmacError as e:
        raise HTTPException(401, f"HMAC verification failed: {e}") from e
    return body
