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

        result = sorted(traces.values(), key=lambda t: t["start_time"], reverse=True)
        return {"traces": result}
    except Exception as exc:
        logger.warning("Failed to query traces: %s", exc)
        return {"traces": [], "error": str(exc)}
