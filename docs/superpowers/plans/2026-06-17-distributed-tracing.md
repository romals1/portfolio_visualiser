# Distributed Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenTelemetry distributed tracing across backend (FastAPI) and frontend (React), storing spans in the existing Supabase Postgres DB, with an in-app trace viewer.

**Architecture:** OTel auto-instrumentation for FastAPI, psycopg2, and requests on the backend captures all HTTP/DB/yfinance timing automatically. A custom `SpanExporter` writes spans directly to a `spans` table in Supabase via the existing psycopg2 pool. The frontend uses `@opentelemetry/sdk-trace-web` with XHR instrumentation for axios calls plus manual spans in `computation.ts`. W3C `traceparent` headers link frontend and backend spans into a single trace. A new `TraceViewer` component (added as a tab) queries `GET /api/traces` and renders waterfall charts.

**Tech Stack:** Python: opentelemetry-api, opentelemetry-sdk, opentelemetry-instrumentation-fastapi, opentelemetry-instrumentation-psycopg2, opentelemetry-instrumentation-requests. TypeScript: @opentelemetry/api, @opentelemetry/sdk-trace-web, @opentelemetry/instrumentation-xml-http-request.

---

### Task 1: Add spans migration

**Goal:** Create the `spans` table in Supabase Postgres so spans have somewhere to land.

**Files:**
- Create: `backend/migrations/0006_spans.sql`

**Acceptance Criteria:**
- [ ] Migration runs via `run_migrations()` at server startup
- [ ] Table has all columns from the design spec
- [ ] Indexes exist on `trace_id`, `start_time`, and `name`
- [ ] Consistent with existing migration style (no RLS, `create table if not exists`)

**Verify:** Start the backend with `DATABASE_URL` set → check Supabase for the `spans` table.

**Steps:**

- [ ] **Step 1: Write the migration**

```sql
-- Distributed tracing spans table.
-- No RLS: spans are operational telemetry, not user data.
create table if not exists spans (
  id              bigserial primary key,
  trace_id        text not null,
  span_id         text not null,
  parent_span_id  text,
  name            text not null,
  kind            text not null default 'INTERNAL',
  service         text not null,
  start_time      timestamptz not null,
  end_time        timestamptz not null,
  duration_ms     double precision not null,
  status          text not null default 'OK',
  status_message  text,
  attributes      jsonb default '{}',
  resource        jsonb default '{}'
);

create index if not exists idx_spans_trace_id on spans (trace_id);
create index if not exists idx_spans_start_time on spans (start_time desc);
create index if not exists idx_spans_name on spans (name);
```

- [ ] **Step 2: Commit**

```bash
git add backend/migrations/0006_spans.sql
git commit -m "feat: add spans table migration for distributed tracing"
```

---

### Task 2: Add backend OTel dependencies

**Goal:** Add OpenTelemetry packages to `requirements.txt`.

**Files:**
- Modify: `backend/requirements.txt`

**Acceptance Criteria:**
- [ ] All 5 OTel packages pinned to compatible versions
- [ ] `pip install -r backend/requirements.txt` succeeds

**Verify:** `cd backend && pip install -r requirements.txt` → no errors.

**Steps:**

- [ ] **Step 1: Append OTel dependencies**

Append to `backend/requirements.txt`:

```
# OpenTelemetry — distributed tracing
opentelemetry-api>=1.27,<2
opentelemetry-sdk>=1.27,<2
opentelemetry-instrumentation-fastapi>=0.48b0,<1
opentelemetry-instrumentation-psycopg2>=0.48b0,<1
opentelemetry-instrumentation-requests>=0.48b0,<1
```

- [ ] **Step 2: Install and verify**

```bash
cd backend && source .venv/bin/activate && pip install -r requirements.txt
```

- [ ] **Step 3: Commit**

```bash
git add backend/requirements.txt
git commit -m "feat: add OpenTelemetry dependencies for backend tracing"
```

---

### Task 3: Create backend tracing service

**Goal:** Create `backend/services/tracing.py` — initializes OTel with a custom Supabase `SpanExporter` and auto-instrumentation.

**Files:**
- Create: `backend/services/tracing.py`

**Acceptance Criteria:**
- [ ] `init_tracing()` configures `TracerProvider` with a custom exporter
- [ ] Custom exporter implements `SpanExporter` and uses `psycopg2.extras.execute_values` for bulk insert into the `spans` table
- [ ] Uses its own `ThreadedConnectionPool` (1-3 connections, separate from price cache pool) reading `DATABASE_URL` or `SUPABASE_DB_URL`
- [ ] `FastAPIInstrumentor().instrument_app(app)` auto-traces all routes
- [ ] `Psycopg2Instrumentor().instrument()` auto-traces all DB queries
- [ ] `RequestsInstrumentor().instrument()` auto-traces yfinance HTTP calls
- [ ] Export runs on a background thread via `ThreadPoolExecutor(max_workers=1)`
- [ ] Export failures are logged, never raised
- [ ] `shutdown_tracing()` flushes remaining spans

**Verify:** Start backend, hit any endpoint, check `spans` table has rows.

**Steps:**

- [ ] **Step 1: Write the tracing service**

```python
# backend/services/tracing.py
"""OpenTelemetry setup with a custom Supabase Postgres SpanExporter."""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Sequence

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider, ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult, BatchSpanProcessor

logger = logging.getLogger(__name__)

_POOL = None
_POOL_LOCK = threading.Lock()
_DB_DISABLED = False
_EXPORT_EXECUTOR: ThreadPoolExecutor | None = None
_SHUTDOWN = False

SERVICE_NAME = "portfolio-api"


def _get_pool():
    global _POOL, _DB_DISABLED
    if _DB_DISABLED:
        return None
    if _POOL is not None:
        return _POOL
    with _POOL_LOCK:
        if _POOL is not None:
            return _POOL
        if _DB_DISABLED:
            return None
        db_url = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_DB_URL")
        if not db_url:
            _DB_DISABLED = True
            logger.info("Tracing: no DATABASE_URL/SUPABASE_DB_URL; spans will not be persisted")
            return None
        try:
            import psycopg2.pool
            _POOL = psycopg2.pool.ThreadedConnectionPool(1, 3, db_url)
            return _POOL
        except Exception as exc:
            logger.warning("Tracing DB pool unavailable: %s", exc)
            _DB_DISABLED = True
            return None


def _get_export_executor() -> ThreadPoolExecutor:
    global _EXPORT_EXECUTOR
    if _EXPORT_EXECUTOR is not None:
        return _EXPORT_EXECUTOR
    _EXPORT_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="span-exporter")
    return _EXPORT_EXECUTOR


class SupabaseSpanExporter(SpanExporter):
    """Writes spans to the `spans` table in Supabase Postgres."""

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        global _SHUTDOWN
        if _SHUTDOWN:
            return SpanExportResult.FAILURE

        pool = _get_pool()
        if pool is None:
            return SpanExportResult.FAILURE

        rows: list[tuple] = []
        for span in spans:
            ctx = span.get_span_context()
            if ctx is None or not ctx.is_valid:
                continue
            parent_id = span.parent
            parent_span_id = None
            if parent_id is not None:
                parent_span_id = format(parent_id.span_id, "016x")

            attrs: dict[str, str] = {}
            if span.attributes:
                attrs = dict(span.attributes)

            resource_attrs: dict[str, str] = {}
            if span.resource and span.resource.attributes:
                resource_attrs = dict(span.resource.attributes)

            start_ns = span.start_time or 0
            end_ns = span.end_time or 0
            duration_ms = (end_ns - start_ns) / 1_000_000

            kind_map = {
                trace.SpanKind.INTERNAL: "INTERNAL",
                trace.SpanKind.SERVER: "SERVER",
                trace.SpanKind.CLIENT: "CLIENT",
            }
            kind_str = kind_map.get(span.kind, "INTERNAL")

            status = "OK"
            status_message = None
            if span.status and not span.status.is_ok:
                status = "ERROR"
                status_message = span.status.description

            rows.append((
                format(ctx.trace_id, "032x"),
                format(ctx.span_id, "016x"),
                parent_span_id,
                span.name or "unnamed",
                kind_str,
                SERVICE_NAME,
                datetime.fromtimestamp(start_ns / 1_000_000_000, tz=timezone.utc),
                datetime.fromtimestamp(end_ns / 1_000_000_000, tz=timezone.utc),
                duration_ms,
                status,
                status_message,
                attrs,
                resource_attrs,
            ))

        if not rows:
            return SpanExportResult.SUCCESS

        _get_export_executor().submit(_insert_rows, pool, rows)
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        global _SHUTDOWN
        _SHUTDOWN = True
        if _EXPORT_EXECUTOR is not None:
            _EXPORT_EXECUTOR.shutdown(wait=True)


def _insert_rows(pool, rows: list[tuple]) -> None:
    """Bulk-insert span rows on a background thread. Never raises."""
    try:
        from psycopg2.extras import execute_values

        conn = pool.getconn()
        try:
            cur = conn.cursor()
            sql = (
                "INSERT INTO spans "
                "(trace_id, span_id, parent_span_id, name, kind, service, "
                "start_time, end_time, duration_ms, status, status_message, attributes, resource) "
                "VALUES %s "
                "ON CONFLICT DO NOTHING"
            )
            execute_values(cur, sql, rows, page_size=200)
            conn.commit()
            cur.close()
        finally:
            pool.putconn(conn)
    except Exception:
        logger.warning("Failed to insert %d span(s)", len(rows), exc_info=True)


def _instrument_app(app) -> None:
    """Attach FastAPI auto-instrumentation."""
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        FastAPIInstrumentor.instrument_app(app, excluded_urls="/api/health")
    except Exception:
        logger.warning("FastAPIInstrumentor failed", exc_info=True)


def _instrument_psycopg2() -> None:
    """Attach psycopg2 auto-instrumentation."""
    try:
        from opentelemetry.instrumentation.psycopg2 import Psycopg2Instrumentor
        Psycopg2Instrumentor().instrument()
    except Exception:
        logger.warning("Psycopg2Instrumentor failed", exc_info=True)


def _instrument_requests() -> None:
    """Attach requests auto-instrumentation (covers yfinance HTTP calls)."""
    try:
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
        RequestsInstrumentor().instrument()
    except Exception:
        logger.warning("RequestsInstrumentor failed", exc_info=True)


def init_tracing(app) -> TracerProvider:
    """Set up OpenTelemetry tracing with Supabase exporter. Call once at startup."""
    resource = Resource.create({"service.name": SERVICE_NAME, "service.version": "2.0.0"})

    exporter = SupabaseSpanExporter()
    processor = BatchSpanProcessor(
        exporter,
        max_export_batch_size=64,
        schedule_delay_millis=2000,
    )
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(processor)
    trace.set_tracer_provider(provider)

    _instrument_app(app)
    _instrument_psycopg2()
    _instrument_requests()

    logger.info("OpenTelemetry tracing initialised (service=%s)", SERVICE_NAME)
    return provider


def shutdown_tracing() -> None:
    """Flush remaining spans. Call at shutdown."""
    global _SHUTDOWN
    _SHUTDOWN = True
    provider = trace.get_tracer_provider()
    if hasattr(provider, "shutdown"):
        provider.shutdown()
    logger.info("Tracing shut down")
```

- [ ] **Step 2: Commit**

```bash
git add backend/services/tracing.py
git commit -m "feat: add OpenTelemetry tracing service with Supabase span exporter"
```

---

### Task 4: Wire tracing into backend main.py

**Goal:** Initialize OTel tracing at server startup via the existing lifespan handler.

**Files:**
- Modify: `backend/main.py`

**Acceptance Criteria:**
- [ ] `init_tracing(app)` called during lifespan startup
- [ ] `shutdown_tracing()` called during lifespan shutdown
- [ ] Tracing setup failure does not prevent server start (try/except)

**Verify:** Start backend → log message "OpenTelemetry tracing initialised" appears.

**Steps:**

- [ ] **Step 1: Modify lifespan in main.py**

Edit `backend/main.py` — in the `lifespan` function, add tracing init/shutdown:

```python
# backend/main.py
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import auth, portfolio
from .services.migrations import run_migrations

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    run_migrations()
    # Initialise distributed tracing
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
        pass


app = FastAPI(title="Portfolio Returns API", version="2.0.0", lifespan=lifespan)

# ... rest of file unchanged ...
```

The specific edit in `main.py`:

**Old (lines 14-16):**
```python
@asynccontextmanager
async def lifespan(_app: FastAPI):
    run_migrations()
    yield
```

**New:**
```python
@asynccontextmanager
async def lifespan(_app: FastAPI):
    run_migrations()
    try:
        from .services.tracing import init_tracing
        init_tracing(_app)
    except Exception:
        logger.warning("Failed to initialise tracing; continuing without", exc_info=True)
    yield
    try:
        from .services.tracing import shutdown_tracing
        shutdown_tracing()
    except Exception:
        pass
```

- [ ] **Step 2: Commit**

```bash
git add backend/main.py
git commit -m "feat: wire OpenTelemetry tracing into FastAPI lifespan"
```

---

### Task 5: Create traces API router

**Goal:** Add `POST /api/traces` (receives frontend spans) and `GET /api/traces` (queries spans for the viewer).

**Files:**
- Create: `backend/routers/traces.py`
- Modify: `backend/routers/__init__.py` (empty — add import export if needed)
- Modify: `backend/main.py` (register the router)

**Acceptance Criteria:**
- [ ] `POST /api/traces` accepts a JSON array of spans and inserts them via the same `spans` table
- [ ] `GET /api/traces` returns traces grouped by `trace_id`, with query params: `limit` (default 50), `min_duration_ms`, `service`, `since_minutes`
- [ ] Both endpoints gracefully no-op when `DATABASE_URL` is absent
- [ ] Router follows the same pattern as `auth.py` (APIRouter, pydantic models)

**Verify:** `curl -X POST localhost:8000/api/traces -H 'Content-Type: application/json' -d '[{...}]'` → 200. `curl localhost:8000/api/traces` → 200 with JSON.

**Steps:**

- [ ] **Step 1: Write the traces router**

```python
# backend/routers/traces.py
"""Endpoints for receiving frontend spans and querying traces."""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger(__name__)

_DB_URL = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_DB_URL")


class SpanInput(BaseModel):
    trace_id: str
    span_id: str
    parent_span_id: str | None = None
    name: str
    kind: str = "CLIENT"
    service: str
    start_time: str  # ISO 8601
    end_time: str
    duration_ms: float
    status: str = "OK"
    status_message: str | None = None
    attributes: dict[str, Any] = {}
    resource: dict[str, Any] = {}


class TraceRequest(BaseModel):
    spans: list[SpanInput]


@router.post("/traces")
def receive_frontend_spans(body: TraceRequest):
    """Accept spans from the frontend OTel exporter."""
    if not _DB_URL:
        return {"received": len(body.spans), "persisted": False}

    try:
        import psycopg2
        from psycopg2.extras import execute_values

        rows: list[tuple] = []
        for s in body.spans:
            rows.append((
                s.trace_id,
                s.span_id,
                s.parent_span_id,
                s.name,
                s.kind,
                s.service,
                s.start_time,
                s.end_time,
                s.duration_ms,
                s.status,
                s.status_message,
                s.attributes,
                s.resource,
            ))

        conn = psycopg2.connect(_DB_URL)
        try:
            conn.autocommit = True
            cur = conn.cursor()
            sql = (
                "INSERT INTO spans "
                "(trace_id, span_id, parent_span_id, name, kind, service, "
                "start_time, end_time, duration_ms, status, status_message, attributes, resource) "
                "VALUES %s "
                "ON CONFLICT DO NOTHING"
            )
            execute_values(cur, sql, rows, page_size=200)
            cur.close()
        finally:
            conn.close()

        return {"received": len(body.spans), "persisted": True}
    except Exception as exc:
        logger.warning("Failed to persist frontend spans: %s", exc)
        return {"received": len(body.spans), "persisted": False, "error": str(exc)}


@router.get("/traces")
def get_traces(
    limit: int = Query(50, ge=1, le=500),
    min_duration_ms: float = Query(0, ge=0),
    service: str | None = None,
    since_minutes: int = Query(60, ge=1, le=1440),
):
    """Return recent traces grouped by trace_id. Each trace includes all its spans."""
    if not _DB_URL:
        return {"traces": []}

    try:
        import psycopg2
        import psycopg2.extras

        since = datetime.now(tz=timezone.utc) - timedelta(minutes=since_minutes)
        conn = psycopg2.connect(_DB_URL)
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

            where = ["start_time >= %s"]
            params: list[Any] = [since]

            if min_duration_ms > 0:
                where.append("duration_ms >= %s")
                params.append(min_duration_ms)
            if service:
                where.append("service = %s")
                params.append(service)

            where_clause = " AND ".join(where)

            # Get the most recent distinct trace_ids first, then fetch all spans
            cur.execute(
                f"SELECT DISTINCT trace_id FROM spans WHERE {where_clause} "
                "ORDER BY start_time DESC LIMIT %s",
                params + [limit],
            )
            trace_ids = [r["trace_id"] for r in cur.fetchall()]

            if not trace_ids:
                return {"traces": []}

            cur.execute(
                "SELECT * FROM spans WHERE trace_id = ANY(%s) ORDER BY start_time ASC",
                (trace_ids,),
            )
            rows = cur.fetchall()

            # Group spans by trace_id
            traces: dict[str, dict] = {}
            for row in rows:
                tid = row["trace_id"]
                if tid not in traces:
                    traces[tid] = {
                        "trace_id": tid,
                        "start_time": row["start_time"].isoformat(),
                        "spans": [],
                    }
                span = dict(row)
                for key in ("start_time", "end_time"):
                    if isinstance(span.get(key), datetime):
                        span[key] = span[key].isoformat()
                traces[tid]["spans"].append(span)

            cur.close()
        finally:
            conn.close()

        # Sort traces by most recent first
        result = sorted(traces.values(), key=lambda t: t["start_time"], reverse=True)
        return {"traces": result}
    except Exception as exc:
        logger.warning("Failed to query traces: %s", exc)
        return {"traces": [], "error": str(exc)}
```

- [ ] **Step 2: Register the router in main.py**

In `backend/main.py`, add the import and router registration:

**Old:**
```python
from .routers import auth, portfolio
```

**New:**
```python
from .routers import auth, portfolio, traces
```

**Old (end of file):**
```python
app.include_router(portfolio.router, prefix="/api", tags=["portfolio"])
```

**New:**
```python
app.include_router(portfolio.router, prefix="/api", tags=["portfolio"])
app.include_router(traces.router, prefix="/api", tags=["traces"])
```

- [ ] **Step 3: Commit**

```bash
git add backend/routers/traces.py backend/main.py
git commit -m "feat: add traces API endpoints (POST frontend spans, GET trace viewer)"
```

---

### Task 6: Add frontend OTel dependencies

**Goal:** Add OpenTelemetry JS packages to the frontend.

**Files:**
- Modify: `frontend/package.json`

**Acceptance Criteria:**
- [ ] `@opentelemetry/api`, `@opentelemetry/sdk-trace-web`, `@opentelemetry/instrumentation-xml-http-request` added to dependencies
- [ ] `npm install` succeeds

**Verify:** `cd frontend && npm install` → no errors.

**Steps:**

- [ ] **Step 1: Add dependencies**

```bash
cd frontend && npm install @opentelemetry/api @opentelemetry/sdk-trace-web @opentelemetry/instrumentation-xml-http-request
```

- [ ] **Step 2: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "feat: add OpenTelemetry JS dependencies for frontend tracing"
```

---

### Task 7: Create frontend tracing library

**Goal:** Create `frontend/src/lib/tracing.ts` — initializes OTel web SDK with a custom exporter that POSTs spans to `/api/traces`.

**Files:**
- Create: `frontend/src/lib/tracing.ts`

**Acceptance Criteria:**
- [ ] `initFrontendTracing()` sets up `WebTracerProvider` with `BatchSpanProcessor`
- [ ] Custom exporter implements `SpanExporter` interface and POSTs JSON to `/api/traces`
- [ ] XHR instrumentation auto-traces axios API calls
- [ ] `getTracer()` returns an OTel tracer for creating manual spans
- [ ] Frontend service name is `"portfolio-frontend"`

**Verify:** Open browser devtools Network tab → after page load, `POST /api/traces` requests appear periodically.

**Steps:**

- [ ] **Step 1: Write the tracing library**

```typescript
// frontend/src/lib/tracing.ts
import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request'
import { registerInstrumentations } from '@opentelemetry/instrumentation'

const SERVICE_NAME = 'portfolio-frontend'

let _tracer: ReturnType<typeof trace.getTracer> | null = null

/**
 * Custom span exporter that POSTs spans to the backend /api/traces endpoint.
 * Avoids the browser CORS issues of OTLP exporters by using the app's own API.
 */
class ApiTraceExporter {
  private _endpoint: string
  private _shutdown: boolean = false

  constructor(endpoint = '/api/traces') {
    this._endpoint = endpoint
  }

  export(spans: any[], resultCallback: (result: { code: number }) => void): void {
    if (this._shutdown || spans.length === 0) {
      resultCallback({ code: 0 })
      return
    }

    const payload = {
      spans: spans.map((span) => ({
        trace_id: span._spanContext?.traceId || '',
        span_id: span._spanContext?.spanId || '',
        parent_span_id: span.parentSpanId || null,
        name: span.name || 'unnamed',
        kind: span.kind === SpanKind.SERVER ? 'SERVER'
          : span.kind === SpanKind.CLIENT ? 'CLIENT'
          : 'INTERNAL',
        service: SERVICE_NAME,
        start_time: span.startTime ? new Date(span.startTime[0] * 1000 + span.startTime[1] / 1_000_000).toISOString() : new Date().toISOString(),
        end_time: span.endTime ? new Date(span.endTime[0] * 1000 + span.endTime[1] / 1_000_000).toISOString() : new Date().toISOString(),
        duration_ms: span.duration ? span.duration[0] * 1000 + span.duration[1] / 1_000_000 : 0,
        status: span.status?.code === SpanStatusCode.ERROR ? 'ERROR' : 'OK',
        status_message: span.status?.message || null,
        attributes: span.attributes || {},
        resource: span.resource?.attributes || {},
      })),
    }

    // Use sendBeacon for reliability; fall back to fetch
    const body = JSON.stringify(payload)
    const sent = navigator.sendBeacon(this._endpoint, body)
    if (!sent) {
      fetch(this._endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {})
    }

    resultCallback({ code: 0 })
  }

  shutdown(): void {
    this._shutdown = true
  }
}

export function initFrontendTracing(): void {
  const exporter = new ApiTraceExporter('/api/traces')
  const processor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: 10,
    scheduledDelayMillis: 5000,
    maxQueueSize: 50,
  })

  const provider = new WebTracerProvider({
    resource: new (window as any).__OTEL_RESOURCE__ ?? undefined,
    spanProcessors: [processor],
  })

  provider.register()
  _tracer = trace.getTracer('portfolio-frontend', '0.1.0')

  // Auto-instrument XMLHttpRequest (covers axios)
  try {
    registerInstrumentations({
      instrumentations: [new XMLHttpRequestInstrumentation()],
    })
  } catch {
    // XHR instrumentation is best-effort
  }
}

export function getTracer() {
  if (!_tracer) {
    _tracer = trace.getTracer('portfolio-frontend', '0.1.0')
  }
  return _tracer
}

/**
 * Create a manual span, execute fn, end the span. Returns fn's result.
 * The span is set as the active context during fn execution.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: ReturnType<typeof trace.getTracer>['startSpan']) => Promise<T>,
  attributes?: Record<string, string>
): Promise<T> {
  const tracer = getTracer()
  const span = tracer.startSpan(name)
  if (attributes) {
    span.setAttributes(attributes)
  }
  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span))
  } catch (err: any) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) })
    throw err
  } finally {
    span.end()
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/tracing.ts
git commit -m "feat: add frontend OTel tracing with custom API exporter"
```

---

### Task 8: Wire frontend tracing into main.tsx

**Goal:** Call `initFrontendTracing()` at app startup.

**Files:**
- Modify: `frontend/src/main.tsx`

**Acceptance Criteria:**
- [ ] Tracing initialized before `<App />` renders

**Verify:** `npm run dev` → no console errors. Check Network tab for POST /api/traces.

**Steps:**

- [ ] **Step 1: Edit main.tsx**

```typescript
// frontend/src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initFrontendTracing } from './lib/tracing'

initFrontendTracing()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/main.tsx
git commit -m "feat: wire frontend tracing init into main entry point"
```

---

### Task 9: Add manual spans to computation.ts

**Goal:** Trace the three key phases of portfolio computation so you can see where time is spent.

**Files:**
- Modify: `frontend/src/lib/computation.ts`

**Acceptance Criteria:**
- [ ] Three manual spans: `compute-portfolio` (top-level), `align-and-compute` (per-portfolio price alignment + return calc), `fx-conversion` (currency conversion)
- [ ] Spans report duration_ms and ticker count as attributes
- [ ] Computation behavior unchanged

**Verify:** Run a compute → check `spans` table for spans named `compute-portfolio`, `align-and-compute`, `fx-conversion`.

**Steps:**

- [ ] **Step 1: Add span imports and wrap the export function**

At the top of `frontend/src/lib/computation.ts`, add the import:

```typescript
import { Transaction, ComputeResult, SymbolData } from '../types'
import api from '../api/client'
import { getTracer, withSpan } from './tracing'
```

The `computePortfolio` function is exported at line ~206. Wrap its body in a `withSpan`, and add inner spans for the two main phases. The key change points:

**a) At the top of `computePortfolio`**, wrap the entire body:

```typescript
export async function computePortfolio(
  transactions: Transaction[],
  benchmarkTickers: string[] = [],
  displayCurrency: 'USD' | 'AUD' = 'USD'
): Promise<ComputeResult> {
  const tracer = getTracer()
  const rootSpan = tracer.startSpan('compute-portfolio', {
    attributes: {
      'txn.count': transactions.length,
      'benchmark.count': benchmarkTickers.length,
      'display.currency': displayCurrency,
    },
  })

  try {
    // ... existing body ...
```

**b) Around the price-fetch call** (approximately line 280, where `api.post('/api/prices', ...)` is called), add:

```typescript
    const fetchSpan = tracer.startSpan('fetch-prices', {
      attributes: { 'ticker.count': allTickers.length },
    })
    let pricesResp: PricesResponse
    try {
      pricesResp = (await api.post('/api/prices', payload)).data
    } finally {
      fetchSpan.end()
    }
```

**c) Around the per-portfolio alignment + computation loop** (approximately lines 290-400), add:

```typescript
    const alignSpan = tracer.startSpan('align-and-compute', {
      attributes: { 'portfolio.count': portfolios.length },
    })
    try {
      // ... existing per-portfolio loop building perfSeries, pureSeries, etc. ...
    } finally {
      alignSpan.end()
    }
```

**d) Around the FX conversion step** (approximately where `latestFxRate` is called and currency conversions happen):

```typescript
    const fxSpan = tracer.startSpan('fx-conversion', {
      attributes: { 'target.currency': displayCurrency },
    })
    try {
      // ... existing FX computation ...
    } finally {
      fxSpan.end()
    }
```

**e) End the root span and return:**

```typescript
    rootSpan.end()
    return result
  } catch (err) {
    rootSpan.setStatus({ code: 2, message: (err as any)?.message || String(err) })
    rootSpan.end()
    throw err
  }
}
```

Note: The exact line numbers depend on the current file structure. The agent implementing this should read the full function and insert spans at the logical boundaries described above, wrapping existing code in `try/finally { span.end() }` blocks.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/computation.ts
git commit -m "feat: add manual OTel spans to portfolio computation phases"
```

---

### Task 10: Create TraceViewer component

**Goal:** Build the in-app trace viewer — list view + waterfall detail.

**Files:**
- Create: `frontend/src/components/TraceViewer.tsx`

**Acceptance Criteria:**
- [ ] List view: recent traces with timestamp, span count, total duration, slowest span
- [ ] Waterfall detail: horizontal bars per span, indented by depth, color-coded (green < 100ms, yellow < 1000ms, red >= 1000ms)
- [ ] Click a span to expand attributes/metadata JSONB
- [ ] Click a trace row to open the waterfall
- [ ] Fetches `GET /api/traces?limit=50&since_minutes=60` on mount
- [ ] Refresh button to re-fetch
- [ ] Matches existing dark/light theme via Tailwind classes
- [ ] Graceful empty state when no traces exist
- [ ] Error state when API is unavailable

**Verify:** `npm run dev` → click Traces tab → see traces waterfall.

**Steps:**

- [ ] **Step 1: Write TraceViewer.tsx**

```typescript
// frontend/src/components/TraceViewer.tsx
import { useState, useEffect } from 'react'
import api from '../api/client'

interface Span {
  id: number
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  kind: string
  service: string
  start_time: string
  end_time: string
  duration_ms: number
  status: string
  status_message: string | null
  attributes: Record<string, any>
  resource: Record<string, any>
}

interface Trace {
  trace_id: string
  start_time: string
  spans: Span[]
}

function durationColor(ms: number): string {
  if (ms < 100) return 'bg-emerald-400'
  if (ms < 1000) return 'bg-amber-400'
  return 'bg-red-400'
}

function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function SpanBar({ span, traceStart, traceDuration, depth, maxNameLen }: {
  span: Span
  traceStart: number
  traceDuration: number
  depth: number
  maxNameLen: number
}) {
  const [expanded, setExpanded] = useState(false)
  const offset = ((new Date(span.start_time).getTime() - traceStart) / traceDuration) * 100
  const width = Math.max((span.duration_ms / traceDuration) * 100, 0.5)

  return (
    <>
      <div className="flex items-center gap-2 text-xs group hover:bg-gray-50 dark:hover:bg-gray-900 py-0.5 px-1 rounded">
        <span
          className="text-gray-400 dark:text-gray-600 font-mono flex-shrink-0"
          style={{ paddingLeft: `${depth * 20}px`, minWidth: `${maxNameLen * 7.5 + depth * 20}px` }}
        >
          {span.name}
        </span>
        <span className="text-gray-400 dark:text-gray-600 flex-shrink-0 w-16 text-right font-mono">
          {formatMs(span.duration_ms)}
        </span>
        <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded-sm relative">
          <div
            className={`absolute top-0 h-full rounded-sm cursor-pointer ${durationColor(span.duration_ms)}`}
            style={{ left: `${offset}%`, width: `${width}%`, minWidth: '4px' }}
            onClick={() => setExpanded(!expanded)}
            title={`${span.name}: ${formatMs(span.duration_ms)}`}
          />
        </div>
        <span className="text-gray-400 dark:text-gray-600 flex-shrink-0 w-12 text-right">
          {span.service.slice(0, 3)}
        </span>
        {span.status === 'ERROR' && (
          <span className="text-red-500 font-bold flex-shrink-0" title={span.status_message || ''}>!</span>
        )}
      </div>
      {expanded && (
        <div
          className="ml-8 mb-2 p-2 bg-gray-50 dark:bg-gray-900 rounded text-xs font-mono text-gray-600 dark:text-gray-400 overflow-x-auto"
          style={{ marginLeft: `${depth * 20 + 20}px` }}
        >
          <pre>{JSON.stringify(span.attributes, null, 2)}</pre>
        </div>
      )}
    </>
  )
}

function Waterfall({ trace, onBack }: { trace: Trace; onBack: () => void }) {
  const spans = trace.spans
  const traceStart = new Date(spans[0]?.start_time || trace.start_time).getTime()
  const traceEnd = Math.max(...spans.map(s => new Date(s.end_time).getTime()))
  const traceDuration = traceEnd - traceStart
  const maxNameLen = Math.max(...spans.map(s => s.name.length))

  // Build parent-child depth
  const depthMap = new Map<string, number>()
  const spanMap = new Map<string, Span>()
  for (const s of spans) {
    spanMap.set(s.span_id, s)
  }
  function getDepth(spanId: string): number {
    if (depthMap.has(spanId)) return depthMap.get(spanId)!
    const span = spanMap.get(spanId)
    if (!span || !span.parent_span_id) {
      depthMap.set(spanId, 0)
      return 0
    }
    const d = getDepth(span.parent_span_id) + 1
    depthMap.set(spanId, d)
    return d
  }
  for (const s of spans) getDepth(s.span_id)

  const totalDuration = traceDuration > 0 ? formatMs(traceDuration) : '<1ms'

  return (
    <div className="space-y-3">
      <button
        onClick={onBack}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        ← Back to list
      </button>
      <div className="text-xs text-gray-500 dark:text-gray-400 space-x-4">
        <span>Trace: {trace.trace_id.slice(0, 16)}…</span>
        <span>{spans.length} spans</span>
        <span>{totalDuration} total</span>
      </div>
      <div className="space-y-0.5">
        {spans.map((span) => (
          <SpanBar
            key={span.id}
            span={span}
            traceStart={traceStart}
            traceDuration={traceDuration}
            depth={depthMap.get(span.span_id) || 0}
            maxNameLen={maxNameLen}
          />
        ))}
      </div>
    </div>
  )
}

export default function TraceViewer() {
  const [traces, setTraces] = useState<Trace[]>([])
  const [selectedTrace, setSelectedTrace] = useState<Trace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTraces = async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await api.get('/api/traces', {
        params: { limit: 50, since_minutes: 60 },
      })
      setTraces(resp.data.traces || [])
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Failed to fetch traces')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTraces()
  }, [])

  if (selectedTrace) {
    return <Waterfall trace={selectedTrace} onBack={() => setSelectedTrace(null)} />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-600 dark:text-gray-400">
          Recent Traces (last 60 min)
        </h3>
        <button
          onClick={fetchTraces}
          disabled={loading}
          className="px-3 py-1 text-xs bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md transition-colors disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="p-4 text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950 rounded-lg">
          {error}
        </div>
      )}

      {!error && !loading && traces.length === 0 && (
        <div className="py-12 text-center text-sm text-gray-400 dark:text-gray-600">
          No traces recorded yet. Use the app and traces will appear here.
        </div>
      )}

      {traces.length > 0 && (
        <div className="space-y-1">
          {/* Table header */}
          <div className="flex items-center gap-4 text-xs text-gray-400 dark:text-gray-600 px-2 py-1 border-b border-gray-100 dark:border-gray-800">
            <span className="w-40">Time</span>
            <span className="w-20 text-right">Spans</span>
            <span className="w-20 text-right">Duration</span>
            <span>Slowest span</span>
          </div>
          {traces.map((trace) => {
            const totalMs = trace.spans.reduce((sum, s) => sum + (s.root_duration || s.duration_ms), 0)
            const maxDuration = Math.max(...trace.spans.map(s => s.duration_ms))
            const slowest = trace.spans.find(s => s.duration_ms === maxDuration)
            return (
              <div
                key={trace.trace_id}
                onClick={() => setSelectedTrace(trace)}
                className="flex items-center gap-4 text-xs px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer transition-colors"
              >
                <span className="w-40 font-mono text-gray-600 dark:text-gray-400">
                  {new Date(trace.start_time).toLocaleTimeString()}
                </span>
                <span className="w-20 text-right text-gray-600 dark:text-gray-400">
                  {trace.spans.length}
                </span>
                <span className="w-20 text-right font-mono text-gray-700 dark:text-gray-300">
                  {formatMs(maxDuration)}
                </span>
                <span className="text-gray-500 dark:text-gray-500 truncate">
                  {slowest?.name || '—'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/TraceViewer.tsx
git commit -m "feat: add TraceViewer component with list and waterfall views"
```

---

### Task 11: Add Traces tab to App.tsx

**Goal:** Add a "Traces" tab to the existing tab bar so users can access the trace viewer.

**Files:**
- Modify: `frontend/src/App.tsx`

**Acceptance Criteria:**
- [ ] "Traces" tab appears alongside Transactions, Holdings, Chart
- [ ] `activeTab` type union includes `'traces'`
- [ ] TraceViewer only renders when the Traces tab is active (lazy: data fetched on tab activation)
- [ ] Existing tabs continue to work unchanged

**Verify:** `npm run dev` → see 4 tabs → click Traces → see TraceViewer.

**Steps:**

- [ ] **Step 1: Import TraceViewer**

Add to imports at top of `App.tsx`:

```typescript
import TraceViewer from './components/TraceViewer'
```

- [ ] **Step 2: Add 'traces' to activeTab type and tabs array**

**Old:**
```typescript
tabs={[
  { id: 'transactions', label: 'Transactions' },
  { id: 'holdings', label: 'Holdings' },
  { id: 'chart', label: 'Chart' },
]}
active={activeTab}
onChange={(id) => setActiveTab(id as 'transactions' | 'holdings' | 'chart')}
```

**New:**
```typescript
tabs={[
  { id: 'transactions', label: 'Transactions' },
  { id: 'holdings', label: 'Holdings' },
  { id: 'chart', label: 'Chart' },
  { id: 'traces', label: 'Traces' },
]}
active={activeTab}
onChange={(id) => setActiveTab(id as 'transactions' | 'holdings' | 'chart' | 'traces')}
```

- [ ] **Step 3: Add the Traces tab panel**

Add after the Chart tab panel (after the closing `</div>` of the chart tabpanel):

```tsx
<div role="tabpanel" className={activeTab === 'traces' ? '' : 'hidden'}>
  <TraceViewer />
</div>
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: add Traces tab to app navigation"
```

---

## Dependency Order

```
Task 1 (spans migration) ─┐
Task 2 (backend deps) ────┤
                           ├── Task 3 (tracing service) ── Task 4 (wire main.py) ── Task 5 (traces router)
Task 6 (frontend deps) ── Task 7 (frontend tracing lib) ── Task 8 (wire main.tsx)
                                                             │
Task 9 (manual spans computation.ts) ────────────────────────┤
                                                             │
Task 10 (TraceViewer component) ── Task 11 (App.tsx tab) ────┘
```

Tasks 1, 2, 6 can run in parallel. Tasks 9 and 10 can run in parallel once 7 is done.
