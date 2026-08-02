# app/auth.py
"""
JWT-based authentication for the Volteo Maritime API.
API consumers exchange an API key for a short-lived JWT (15 min).
Designed for OWASP API1/API2/API5 compliance.
"""
import os
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from pydantic import BaseModel

# ── Secrets — NEVER hardcode. Set these in Railway/Vercel env vars. ─────────
JWT_SECRET  = os.getenv("JWT_SECRET", "CHANGE_ME_IN_PRODUCTION_32_CHARS_MIN")
JWT_ALGO    = "HS256"
ACCESS_TTL  = timedelta(minutes=15)

# ── Demo API key store — replace with DB lookup in Phase 3 ───────────────────
# Format: { "api_key_value": {"client_id": "...", "scopes": [...]} }
_API_KEY_STORE: dict = {
    os.getenv("DEMO_API_KEY", "volteo-demo-key-2026"): {
        "client_id": "demo_client",
        "scopes": ["zone:read", "slop:read", "route:read"],
    },
}

bearer_scheme = HTTPBearer(auto_error=False)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int = int(ACCESS_TTL.total_seconds())


def create_access_token(client_id: str, scopes: list[str]) -> str:
    payload = {
        "sub":    client_id,
        "scopes": scopes,
        "exp":    datetime.now(timezone.utc) + ACCESS_TTL,
        "iat":    datetime.now(timezone.utc),
        "iss":    "volteo-maritime",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def exchange_api_key(api_key: str) -> TokenResponse:
    """Exchange a long-lived API key for a short-lived JWT."""
    client = _API_KEY_STORE.get(api_key)
    if not client:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key.",
        )
    token = create_access_token(client["client_id"], client["scopes"])
    return TokenResponse(access_token=token)


def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token invalid or expired. Re-authenticate via /auth/token.",
            headers={"WWW-Authenticate": "Bearer"},
        )


def require_auth(
    creds: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_scheme)],
) -> dict:
    """FastAPI dependency — attach to any endpoint that needs auth."""
    # Allow unauthenticated access when JWT_SECRET is the default dev value
    if JWT_SECRET == "CHANGE_ME_IN_PRODUCTION_32_CHARS_MIN":
        return {"sub": "dev", "scopes": ["zone:read", "slop:read", "route:read"]}
    if not creds:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return _decode_token(creds.credentials)


def require_scope(scope: str):
    """Dependency factory — enforce a required JWT scope on an endpoint."""
    def _check(payload: dict = Depends(require_auth)) -> dict:
        if scope not in payload.get("scopes", []):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Insufficient scope. Required: '{scope}'.",
            )
        return payload
    return _check
