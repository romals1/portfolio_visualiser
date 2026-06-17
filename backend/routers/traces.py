"""Endpoints for receiving frontend spans and querying traces."""

from __future__ import annotations

import json as json_mod
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel

from ..services import db

router = APIRouter()
logger = logging.getLogger(__name__)

_COLS = [
    "id", "trace_id", "span_id", "parent_span_id", "name", "kind",
    "service", "start_time", "end_time", "duration_ms", "status",
    "status_message", "attributes", "resource",
]


class SpanInput(BaseModel):
    trace_id: str
    span_id: str
    parent_span_id: str | None = None
    name: str
    kind: str = "CLIENT"
    service: str
    start_time: str
    end_time: str
    duration_ms: float
    status: str = "OK"
    status_message: str | None = None
    attributes: dict[str, Any] = {}
    resource: dict[str, Any] = {}


class TraceRequest(BaseModel):
    spans: list[SpanInput]


def _row_to_dict(row) -> dict:
    """Convert a DB row (tuple or dict) to a dict, deserializing JSON cols."""
    if isinstance(row, dict):
        d = dict(row)
    else:
        d = {_COLS[i]: row[i] for i in range(len(_COLS))}
    # Deserialize JSON string cols back to dicts (SQLite stores them as text)
    for col in ("attributes", "resource"):
        if isinstance(d.get(col), str):
            try:
                d[col] = json_mod.loads(d[col])
            except (json_mod.JSONDecodeError, TypeError):
                pass
    return d


@router.post("/traces")
def receive_frontend_spans(body: TraceRequest):
    """Accept spans from the frontend OTel exporter."""
    try:
        with db.get_conn() as conn:
            rows = [
                (
                    s.trace_id, s.span_id, s.parent_span_id, s.name, s.kind,
                    s.service, s.start_time, s.end_time, s.duration_ms,
                    s.status, s.status_message,
                    json_mod.dumps(s.attributes),
                    json_mod.dumps(s.resource),
                )
                for s in body.spans
            ]
            cur = conn.cursor()
            db.execute_values(
                cur,
                "INSERT INTO spans "
                "(trace_id, span_id, parent_span_id, name, kind, service, "
                "start_time, end_time, duration_ms, status, status_message, attributes, resource) "
                "VALUES %s ON CONFLICT DO NOTHING",
                rows,
                page_size=200,
            )
            conn.commit()
            cur.close()
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
    """Return recent traces grouped by trace_id."""
    try:
        since = datetime.now(tz=timezone.utc) - timedelta(minutes=since_minutes)
        since_iso = since.isoformat()

        with db.get_conn() as conn:
            cur = conn.cursor()

            where = ["start_time >= %s"]
            params: list[Any] = [since_iso]

            if min_duration_ms > 0:
                where.append("duration_ms >= %s")
                params.append(min_duration_ms)
            if service:
                where.append("service = %s")
                params.append(service)

            where_clause = " AND ".join(where)

            trace_sql = (
                f"SELECT DISTINCT trace_id FROM spans WHERE {where_clause} "
                "ORDER BY start_time DESC LIMIT %s"
            )
            db.db_execute(cur, trace_sql, tuple(params + [limit]))
            trace_ids = [r[0] if not isinstance(r, dict) else r["trace_id"] for r in cur.fetchall()]

            if not trace_ids:
                cur.close()
                return {"traces": []}

            detail_sql = "SELECT * FROM spans WHERE trace_id = ANY(%s) ORDER BY start_time ASC"
            detail_sql, _ = db.expand_in(detail_sql, trace_ids)
            db.db_execute(cur, detail_sql, tuple(trace_ids))
            rows = cur.fetchall()
            cur.close()

            traces: dict[str, dict] = {}
            for row in rows:
                d = _row_to_dict(row)
                tid = d["trace_id"]
                if tid not in traces:
                    traces[tid] = {
                        "trace_id": tid,
                        "start_time": str(d["start_time"]),
                        "spans": [],
                    }
                for key in ("start_time", "end_time"):
                    if isinstance(d.get(key), datetime):
                        d[key] = d[key].isoformat()
                    elif d.get(key) and not isinstance(d.get(key), str):
                        d[key] = str(d[key])
                traces[tid]["spans"].append(d)

        result = sorted(traces.values(), key=lambda t: str(t.get("start_time", "")), reverse=True)
        return {"traces": result}
    except Exception as exc:
        logger.warning("Failed to query traces: %s", exc)
        return {"traces": [], "error": str(exc)}
