# app/main.py
import os
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.auth import TokenResponse, exchange_api_key, require_scope
from app.models import ShipRequest
from app.problem_details import register_exception_handlers
from app.rate_limit import limiter
from app.routers.check_zone import router as check_zone_router
from app.spatial_index import index_stats

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR   = PROJECT_ROOT / "static"
INDEX_HTML   = PROJECT_ROOT / "index.html"

app = FastAPI(
    title="Volteo Maritime MARPOL Compliance API",
    description=(
        "Checks whether ship coordinates fall inside MARPOL special areas, "
        "estimates distance to nearest land, and returns disposal guidance "
        "and operational compliance checklists across supported annexes.\n\n"
        "**Authentication:** Exchange your API key for a short-lived JWT via "
        "`POST /auth/token`, then pass `Authorization: Bearer <token>` on "
        "all `/api/v1/` endpoints.\n\n"
        "Errors are returned as RFC 7807 `application/problem+json` documents."
    ),
    version="3.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# ── Rate limiter state ────────────────────────────────────────────────────────
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

register_exception_handlers(app)

# ── CORS — explicit allowlist, no wildcard ────────────────────────────────────
_origins = [
    "http://127.0.0.1:3000",  "http://localhost:3000",
    "http://127.0.0.1:5500",  "http://localhost:5500",
    "http://127.0.0.1:8000",  "http://localhost:8000",
    "https://volteo-maritime-marpol-zone-api.up.railway.app",
    "https://volteo-maritime-dashboard-deploy.vercel.app",
]
_extra = os.getenv("ALLOWED_ORIGIN")
if _extra:
    _origins.append(_extra)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,          # explicit list — no "*"
    allow_credentials=True,
    allow_methods=["GET", "POST"],   # no DELETE/PUT/PATCH needed
    allow_headers=["Authorization", "Content-Type"],
)

# ── Auth token endpoint ───────────────────────────────────────────────────────
@app.post(
    "/auth/token",
    response_model=TokenResponse,
    summary="Exchange API key for JWT access token",
    tags=["Auth"],
)
@limiter.limit("10/minute")
async def get_token(request: Request, api_key: str):
    """Pass your API key as a query param: `POST /auth/token?api_key=...`"""
    return exchange_api_key(api_key)


# ── Versioned API routers ─────────────────────────────────────────────────────
app.include_router(check_zone_router)

# ── Static + Dashboard ───────────────────────────────────────────────────────
if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/health", tags=["Ops"])
@limiter.limit("60/minute")
async def health(request: Request):
    return {
        "status": "ok",
        "service": "Volteo Maritime MARPOL Compliance API",
        "version": "3.0.0",
        "spatial_index": index_stats(),
    }


@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse(url="/docs")


@app.get("/dashboard", include_in_schema=False)
async def dashboard():
    if INDEX_HTML.is_file():
        return FileResponse(str(INDEX_HTML), media_type="text/html")
    return RedirectResponse(url="/docs")
