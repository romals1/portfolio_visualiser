from __future__ import annotations

import logging
from pathlib import Path

from . import db

logger = logging.getLogger(__name__)

_MIGRATIONS_DIR = Path(__file__).parent.parent / "migrations"


def run_migrations() -> None:
    """Run migrations against the active database.

    Postgres: runs *.sql files in order (production).
    SQLite:   runs sqlite_schema.sql as a single DDL (local dev).
    Errors are logged but never raised so the server still starts.
    """
    if db.is_postgres:
        _run_pg_migrations()
    else:
        _run_sqlite_schema()


def _run_pg_migrations() -> None:
    sql_files = sorted(f for f in _MIGRATIONS_DIR.glob("*.sql") if f.name != "sqlite_schema.sql")
    if not sql_files:
        return
    try:
        with db.get_conn() as conn:
            cur = conn.cursor()
            for sql_file in sql_files:
                try:
                    cur.execute(sql_file.read_text())
                    logger.info("Applied migration: %s", sql_file.name)
                except Exception as exc:
                    logger.debug("Migration %s skipped: %s", sql_file.name, exc)
            cur.close()
    except Exception as exc:
        logger.error("Auto-migration failed: %s", exc)


def _run_sqlite_schema() -> None:
    schema_file = _MIGRATIONS_DIR / "sqlite_schema.sql"
    if not schema_file.exists():
        logger.warning("SQLite schema file not found at %s", schema_file)
        return
    try:
        with db.get_conn() as conn:
            cur = conn.cursor()
            cur.executescript(schema_file.read_text())
            conn.commit()
            cur.close()
            logger.info("Applied SQLite schema")
    except Exception as exc:
        logger.error("SQLite schema init failed: %s", exc)
