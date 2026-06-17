from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import auth, portfolio, traces
from .services.migrations import run_migrations


logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    run_migrations()
    # Initialize distributed tracing
    try:
        from .services.tracing import init_tracing

        init_tracing(_app)
    except Exception:
        logger.warning("Failed to initialise tracing; continuing without", exc_info=True)
    yield
    # Shut down tracing
    try:
        from .services.tracing import shutdown_tracing

        shutdown_tracing()
    except Exception:
        logger.warning("Failed to shut down tracing", exc_info=True)


app = FastAPI(title="Portfolio Returns API", version="2.0.0", lifespan=lifespan)

allowed_origins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:4173",
]
frontend_url = os.getenv("FRONTEND_URL", "").strip()
if frontend_url:
    allowed_origins.append(frontend_url)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(portfolio.router, prefix="/api", tags=["portfolio"])
app.include_router(traces.router, prefix="/api", tags=["traces"])


@app.get("/api/health")
def health():
    return {"status": "ok"}
