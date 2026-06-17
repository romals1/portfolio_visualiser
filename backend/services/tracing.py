"""OpenTelemetry setup with a custom Supabase Postgres SpanExporter."""

from __future__ import annotations

import logging
import os
import threading
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
_EXPORT_EXECUTOR_LOCK = threading.Lock()
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
    with _EXPORT_EXECUTOR_LOCK:
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
