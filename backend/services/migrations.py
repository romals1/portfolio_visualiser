from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

_MIGRATIONS_DIR = Path(__file__).parent.parent / "migrations"


def run_migrations() -> None:
    """Run all *.sql migration files in order against DATABASE_URL or SUPABASE_DB_URL.

    Silent no-op when the env var is absent (dev without a real DB, tests, etc.).
    Errors are logged but never raised so the server still starts.
    """
    db_url = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_DB_URL")
    if not db_url:
        logger.info("No DATABASE_URL set; skipping auto-migration")
        return

    try:
        import psycopg2
    except ImportError:
        logger.warning(
            "psycopg2 not installed; skipping auto-migration. "
            "Run migrations manually or add psycopg2-binary to requirements."
        )
        return

    sql_files = sorted(_MIGRATIONS_DIR.glob("*.sql"))
    if not sql_files:
        return

    try:
        conn = psycopg2.connect(db_url)
        conn.autocommit = True
        cur = conn.cursor()
        for sql_file in sql_files:
            cur.execute(sql_file.read_text())
            logger.info("Applied migration: %s", sql_file.name)
        cur.close()
        conn.close()
    except Exception as exc:
        logger.error("Auto-migration failed: %s", exc)
