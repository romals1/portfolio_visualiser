# Distributed Tracing with OpenTelemetry + Supabase

**Date:** 2026-06-17
**Status:** Design approved

## Problem

Deployed app takes ~16 seconds (warm) to load saved transactions and compute portfolio stats. No visibility into where time is spent across the price-fetch pipeline, DB queries, yfinance calls, or client-side computation.

## Approach

**OpenTelemetry** with a custom Supabase `SpanExporter`. Auto-instrumentation covers FastAPI routes, PostgreSQL queries, and HTTP calls with zero code changes. W3C `traceparent` headers link frontend and backend spans into a single trace. A trace viewer built into the existing React app queries the `spans` table and renders waterfall charts.

## Architecture

```
┌─ Frontend (React) ─────────────────────────────────────────────┐
│  @opentelemetry/instrumentation-fetch  ← auto-traces API calls  │
│  Manual spans in computation.ts        ← traces compute steps  │
│  Span exporter → POST /api/traces       ← writes to Supabase   │
│  TraceViewer component                  ← waterfall chart       │
└───────────────┬─────────────────────────────────────────────────┘
                │ W3C traceparent header
                ▼
┌─ Backend (FastAPI) ────────────────────────────────────────────┐
│  opentelemetry-instrumentation-fastapi   ← auto-traces routes  │
│  opentelemetry-instrumentation-psycopg2  ← auto-traces DB      │
│  opentelemetry-instrumentation-requests  ← auto-traces HTTP    │
│  Custom SpanExporter → Supabase spands table                   │
│  POST /api/traces endpoint               ← receives frontend    │
└───────────────┬─────────────────────────────────────────────────┘
                │
                ▼
┌─ Supabase ─────────────────────────────────────────────────────┐
│  spans table (trace_id, span_id, parent_span_id, name,         │
│              duration_ms, attributes JSONB, start_time, ...)   │
└────────────────────────────────────────────────────────────────┘
```

## Data Model

Single `spans` table in the existing Supabase Postgres:

```sql
CREATE TABLE spans (
    id              BIGSERIAL PRIMARY KEY,
    trace_id        TEXT NOT NULL,
    span_id         TEXT NOT NULL,
    parent_span_id  TEXT,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'INTERNAL',
    service         TEXT NOT NULL,
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ NOT NULL,
    duration_ms     DOUBLE PRECISION NOT NULL,
    status          TEXT NOT NULL DEFAULT 'OK',
    status_message  TEXT,
    attributes      JSONB DEFAULT '{}',
    resource        JSONB DEFAULT '{}'
);

CREATE INDEX idx_spans_trace_id ON spans (trace_id);
CREATE INDEX idx_spans_start_time ON spans (start_time DESC);
CREATE INDEX idx_spans_name ON spans (name);
```

All spans share a `trace_id` within one user action. `parent_span_id` builds the tree. `service` = `'backend'` or `'frontend'`.

## Components

### 1. Custom SpanExporter (backend)

- Implements OTel `SpanExporter` interface (~40 lines)
- Bulk-inserts spans into `spans` table via existing `psycopg2` pool from `price_cache_db.py`
- Runs on a background thread (no request blocking)
- Flushes on shutdown

### 2. Trace receiver endpoint

- `POST /api/traces` — accepts frontend spans as JSON
- Frontend can't write directly to Postgres, so this proxies to the same exporter path
- Protected by existing auth middleware

### 3. Backend instrumentation

- `opentelemetry-instrumentation-fastapi` — auto-traces all routes
- `opentelemetry-instrumentation-psycopg2` — auto-traces Supabase PG queries
- `opentelemetry-instrumentation-requests` — auto-traces yfinance HTTP calls
- Zero changes to existing route/service code

### 4. Frontend instrumentation

- `@opentelemetry/instrumentation-fetch` — auto-traces `/api/*` calls
- Manual spans in `computation.ts` at three checkpoints:
  - `compute-portfolio` — top-level parent
  - `align-and-compute` — price alignment + return calculation per portfolio
  - `fx-conversion` — AUD↔USD conversion
- Batch exporter sends spans to `POST /api/traces` every 5s or 10 spans

### 5. Trace viewer

- New `TraceViewer` component, added as a tab alongside Performance/Holdings/Transactions
- **List view:** most recent traces with span count, total duration, slowest span
- **Waterfall detail:** horizontal bars per span, indented by depth, color-coded by duration (green/yellow/red)
- Click a span to see attributes JSONB
- Filters: service, time range, min duration
- Queries `GET /api/traces` on tab activation only (no background polling)

### 6. Trace query endpoint

- `GET /api/traces?limit=50&min_duration_ms=100&service=backend`
- Queries `spans` table, returns traces grouped by `trace_id`
- Uses existing auth

## New Dependencies

### Python (backend)

```
opentelemetry-api>=1.27
opentelemetry-sdk>=1.27
opentelemetry-instrumentation-fastapi>=0.48b0
opentelemetry-instrumentation-psycopg2>=0.48b0
opentelemetry-instrumentation-requests>=0.48b0
```

### TypeScript (frontend)

```
@opentelemetry/api
@opentelemetry/sdk-trace-web
@opentelemetry/instrumentation-fetch
```

## Files to Create/Modify

| File | Action | Purpose |
|---|---|---|
| `backend/services/tracing.py` | Create | OTel setup, custom exporter, `init_tracing()` |
| `backend/main.py` | Modify | Call `init_tracing()` at startup |
| `backend/routers/traces.py` | Create | `POST /api/traces`, `GET /api/traces` |
| `backend/services/migrations.py` | Modify | Add `spans` table migration |
| `frontend/src/lib/tracing.ts` | Create | OTel web setup, manual span helpers |
| `frontend/src/main.tsx` | Modify | Call `initFrontendTracing()` |
| `frontend/src/lib/computation.ts` | Modify | Add manual spans at 3 checkpoints |
| `frontend/src/components/TraceViewer.tsx` | Create | Waterfall viewer component |
| `frontend/src/App.tsx` | Modify | Add Traces tab |

## What we DON'T do

- No separate OTel Collector process (exporter writes directly to Supabase)
- No trace sampling initially (collect everything; add sampling later if volume is high)
- No trace retention policy yet (manual cleanup if needed)
- No alerting on slow traces (out of scope for v1)
