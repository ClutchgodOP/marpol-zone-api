import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.problem_details import register_exception_handlers
from app.routers.check_zone import router as check_zone_router
from app.spatial_index import index_stats

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = PROJECT_ROOT / "static"
INDEX_HTML = PROJECT_ROOT / "index.html"

app = FastAPI(
    title="Volteo Maritime MARPOL Compliance API",
    description=(
        "Checks whether ship coordinates fall inside MARPOL special areas, "
        "estimates distance to nearest land, and returns disposal guidance "
        "and operational compliance checklists across supported annexes. "
        "Errors are returned as RFC 7807 application/problem+json documents."
    ),
    version="2.0.0",
)

# Registered before the routers so that ProblemException, RequestValidationError
# and unhandled exceptions all render as problem+json.
register_exception_handlers(app)

origins = [
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "https://volteo-maritime-marpol-zone-api.up.railway.app",
    "https://volteo-maritime-dashboard-deploy.vercel.app",
    "null",
]

_prod_origin = os.getenv("ALLOWED_ORIGIN")
if _prod_origin:
    origins.append(_prod_origin)

# The dashboard is served from this same origin (the "/" and /static routes
# below), so CORS only matters for development against a separately served
# frontend and for the deployed dashboard hosts listed above.
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(check_zone_router)

if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "Volteo Maritime MARPOL Compliance API",
        "version": "2.0.0",
        "spatial_index": index_stats(),
    }


@app.get("/", include_in_schema=False)
async def root():
    """The API root shows the interactive Swagger UI; the dashboard is hosted
    separately (Vercel) and also remains available here at /dashboard."""
    return RedirectResponse(url="/docs")


@app.get("/dashboard", include_in_schema=False)
async def dashboard():
    """Serve the bundled dashboard (useful for local development)."""
    if INDEX_HTML.is_file():
        return FileResponse(str(INDEX_HTML), media_type="text/html")
    return RedirectResponse(url="/docs")
