import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from app.routers.check_zone import router as check_zone_router

app = FastAPI(
    title="Volteo Maritime MARPOL Compliance API",
    description=(
        "Checks whether ship coordinates fall inside MARPOL special areas, "
        "estimates distance to nearest land, and returns disposal guidance "
        "and operational compliance checklists across supported annexes."
    ),
    version="2.0.0",
)

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

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(check_zone_router)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "Volteo Maritime MARPOL Compliance API",
        "version": "2.0.0",
    }


@app.get("/")
async def root():
    return RedirectResponse(url="/docs")
