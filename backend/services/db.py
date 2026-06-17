"""Unified DB adapter: Postgres when DATABASE_URL is set, SQLite otherwise.

Exports:
  db_available() -> bool        Always True (SQLite fallback ensures this)
  get_conn() -> connection      Context manager yielding a DB connection
  adapt_sql(sql: str) -> str    Rewrite PG-specific SQL for the active backend
  execute_values(cur, sql, rows, page_size)  psycopg2-compatible bulk insert
  is_postgres -> bool           True when talking to a real Postgres
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

logger = logging.getLogger(__name__)

_DB_URL = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_DB_URL")
is_postgres = bool(_DB_URL)

_db_path: Path | None = None
_pg_pool = None
_pg_pool_lock = threading.Lock()
_pg_disabled = False
_sqlite_conn: sqlite3.Connection | None = None
_sqlite_lock = threading.Lock()


def db_available() -> bool:
    """Always True — falls back to SQLite when no Postgres URL is set."""
    return True


# ── Postgres path ────────────────────────────────────────────────────────────

def _get_pg_pool():
    global _pg_pool, _pg_disabled
    if _pg_disabled:
        return None
    if _pg_pool is not None:
        return _pg_pool
    with _pg_pool_lock:
        if _pg_pool is not None:
            return _pg_pool
        if _pg_disabled:
            return None
        if not _DB_URL:
            _pg_disabled = True
            return None
        try:
            import psycopg2.pool
            _pg_pool = psycopg2.pool.ThreadedConnectionPool(1, 5, _DB_URL)
            return _pg_pool
        except Exception as exc:
            logger.warning("Postgres pool unavailable: %s", exc)
            _pg_disabled = True
            return None


# ── SQLite path ──────────────────────────────────────────────────────────────

def _ensure_sqlite() -> Path:
    global _db_path
    if _db_path is not None:
        return _db_path
    # Place the SQLite DB at the project root (3 levels up from this file)
    # db.py is in backend/services/; project root is backend/../
    project_root = Path(__file__).parent.parent.parent
    _db_path = project_root / "data" / "local.db"
    _db_path.parent.mkdir(parents=True, exist_ok=True)
    return _db_path


def _get_sqlite_conn() -> sqlite3.Connection:
    global _sqlite_conn
    if _sqlite_conn is not None:
        return _sqlite_conn
    with _sqlite_lock:
        if _sqlite_conn is not None:
            return _sqlite_conn
        db_path = _ensure_sqlite()
        _sqlite_conn = sqlite3.connect(str(db_path), check_same_thread=False)
        _sqlite_conn.execute("PRAGMA journal_mode=WAL")
        _sqlite_conn.execute("PRAGMA foreign_keys=ON")
        return _sqlite_conn


# ── Public API ───────────────────────────────────────────────────────────────

@contextmanager
def get_conn() -> Generator[Any, None, None]:
    """Yield a connection-like object (psycopg2 or sqlite3)."""
    if is_postgres:
        pool = _get_pg_pool()
        if pool is None:
            # Postgres configured but unavailable — fall back to SQLite.
            # This handles the case where the app starts before the DB is ready.
            conn = _get_sqlite_conn()
            try:
                yield conn
            finally:
                pass  # SQLite connection is shared; don't close
            return
        conn = pool.getconn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            pool.putconn(conn)
    else:
        conn = _get_sqlite_conn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise


# ── SQL adaptation ───────────────────────────────────────────────────────────

_SQLITE_REPLACEMENTS: list[tuple[str, str]] = [
    # Types
    ("bigserial", "INTEGER PRIMARY KEY AUTOINCREMENT"),
    ("bigint", "INTEGER"),
    ("timestamptz", "TEXT"),
    ("jsonb", "TEXT"),
    ("double precision", "REAL"),
    ("numeric", "REAL"),
    # Conflicts
    ("ON CONFLICT DO NOTHING", "ON CONFLICT DO NOTHING"),  # handled below
    # PG-isms
    ("now()", "datetime('now')"),
]


def adapt_sql(sql: str) -> str:
    """Rewrite PG-specific SQL for the active backend."""
    if is_postgres:
        return sql
    s = sql
    # Type mappings
    s = s.replace("bigserial", "INTEGER PRIMARY KEY AUTOINCREMENT")
    s = s.replace("BIGSERIAL", "INTEGER PRIMARY KEY AUTOINCREMENT")
    s = s.replace("bigint", "INTEGER")
    s = s.replace("timestamptz", "TEXT")
    s = s.replace("jsonb", "TEXT")
    s = s.replace("double precision", "REAL")
    s = s.replace("numeric", "REAL")
    # ON CONFLICT DO NOTHING -> INSERT OR IGNORE (best-effort)
    s = s.replace("ON CONFLICT DO NOTHING", "")
    # PG now() -> SQLite datetime
    s = s.replace("now()", "datetime('now')")
    # Remove PG-specific modifiers that SQLite doesn't understand
    s = s.replace("::timestamptz", "")
    return s


def execute_values(
    cur: Any,
    sql_template: str,
    rows: list[tuple],
    page_size: int = 1000,
) -> None:
    """Bulk insert rows — psycopg2.extras.execute_values compatible.

    For Postgres: uses the native execute_values.
    For SQLite: uses executemany with adapted SQL.
    """
    if is_postgres:
        try:
            from psycopg2.extras import execute_values as pg_execute_values
            pg_execute_values(cur, sql_template, rows, page_size=page_size)
            return
        except ImportError:
            pass

    # SQLite path: rewrite VALUES %s to VALUES (?,?,...), then executemany
    placeholders = ", ".join(["?"] * len(rows[0])) if rows else ""
    sql = sql_template.replace("%s", f"({placeholders})")
    # If the template uses ON CONFLICT, rewrite to INSERT OR IGNORE
    if "ON CONFLICT" in sql:
        sql = sql.replace("INSERT INTO", "INSERT OR IGNORE INTO")
        # Strip the ON CONFLICT clause
        import re
        sql = re.sub(r"\s*ON CONFLICT\s+DO\s+NOTHING", "", sql)
    cur.executemany(sql, rows)


def expand_in(sql: str, values: list) -> tuple[str, list]:
    """Replace = ANY(%s) with IN (?, ?, ...) for SQLite.

    For Postgres this returns unchanged (psycopg2 handles ANY natively).
    Returns (adapted_sql, []) — the values list should already be in the params tuple.
    """
    if is_postgres:
        return sql, []
    placeholders = ", ".join(["?"] * len(values))
    sql = sql.replace("= ANY(%s)", f"IN ({placeholders})")
    return sql, []


def db_execute(cur: Any, sql: str, params: tuple | None = None) -> Any:
    """Execute SQL, adapting placeholders for SQLite.

    psycopg2 uses %s; sqlite3 uses ?. This normalises to the active backend.
    """
    if not is_postgres:
        sql = sql.replace("%s", "?")
    if params is not None:
        return cur.execute(sql, params)
    return cur.execute(sql)
