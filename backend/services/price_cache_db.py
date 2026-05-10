from __future__ import annotations

import logging
import os
import threading
from contextlib import contextmanager
from datetime import date, timedelta
from typing import Generator

import pandas as pd

logger = logging.getLogger(__name__)

_POOL = None
_POOL_LOCK = threading.Lock()
_DB_DISABLED = False


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
            return None
        try:
            import psycopg2.pool
            _POOL = psycopg2.pool.ThreadedConnectionPool(1, 5, db_url)
            return _POOL
        except Exception as exc:
            logger.warning("Price cache DB unavailable: %s", exc)
            _DB_DISABLED = True
            return None


def db_available() -> bool:
    return _get_pool() is not None


@contextmanager
def _conn() -> Generator:
    pool = _get_pool()
    if pool is None:
        yield None
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


def gaps(
    req_start: date,
    req_end: date,
    covered: list[tuple[date, date]],
) -> list[tuple[date, date]]:
    """Return sub-ranges of [req_start, req_end) not covered by the given intervals.

    req_end is exclusive (like yfinance end). covered ranges are inclusive on both ends.
    """
    req_end_incl = req_end - timedelta(days=1)
    intervals = sorted(covered)
    cursor = req_start
    out: list[tuple[date, date]] = []
    for cs, ce in intervals:
        if ce < req_start:
            continue
        if cs > req_end_incl:
            break
        cs = max(cs, req_start)
        ce = min(ce, req_end_incl)
        if cursor < cs:
            out.append((cursor, cs - timedelta(days=1)))
        cursor = max(cursor, ce + timedelta(days=1))
    if cursor <= req_end_incl:
        out.append((cursor, req_end_incl))
    return out


def load_prices(
    yahoo_symbol: str,
    start: date,
    end: date,
) -> tuple[pd.Series, list[tuple[date, date]]]:
    """Load cached prices from DB. Returns (series, covered_ranges). end is exclusive."""
    with _conn() as conn:
        if conn is None:
            return pd.Series(dtype="float64"), []
        try:
            cur = conn.cursor()
            end_incl = end - timedelta(days=1)
            cur.execute(
                "SELECT price_date, close_price FROM ticker_prices "
                "WHERE yahoo_symbol = %s AND price_date >= %s AND price_date <= %s "
                "ORDER BY price_date",
                (yahoo_symbol, start, end_incl),
            )
            rows = cur.fetchall()
            cur.execute(
                "SELECT range_start, range_end FROM ticker_fetch_ranges "
                "WHERE yahoo_symbol = %s AND kind = 'price' "
                "AND range_end >= %s AND range_start <= %s",
                (yahoo_symbol, start, end_incl),
            )
            range_rows = cur.fetchall()
            cur.close()

            if not rows:
                series = pd.Series(dtype="float64")
            else:
                idx = pd.to_datetime([r[0] for r in rows])
                vals = [float(r[1]) for r in rows]
                series = pd.Series(vals, index=idx, name=yahoo_symbol)

            covered = [(r[0], r[1]) for r in range_rows]
            return series, covered
        except Exception as exc:
            logger.warning("load_prices DB error: %s", exc)
            return pd.Series(dtype="float64"), []


def load_dividends(
    yahoo_symbol: str,
    start: date,
    end: date,
) -> tuple[pd.Series, list[tuple[date, date]]]:
    """Load cached dividends from DB. Returns (series, covered_ranges). end is exclusive."""
    with _conn() as conn:
        if conn is None:
            return pd.Series(dtype="float64"), []
        try:
            cur = conn.cursor()
            end_incl = end - timedelta(days=1)
            cur.execute(
                "SELECT ex_date, amount FROM ticker_dividends "
                "WHERE yahoo_symbol = %s AND ex_date >= %s AND ex_date <= %s "
                "ORDER BY ex_date",
                (yahoo_symbol, start, end_incl),
            )
            rows = cur.fetchall()
            cur.execute(
                "SELECT range_start, range_end FROM ticker_fetch_ranges "
                "WHERE yahoo_symbol = %s AND kind = 'dividend' "
                "AND range_end >= %s AND range_start <= %s",
                (yahoo_symbol, start, end_incl),
            )
            range_rows = cur.fetchall()
            cur.close()

            if not rows:
                series = pd.Series(dtype="float64")
            else:
                idx = pd.to_datetime([r[0] for r in rows])
                vals = [float(r[1]) for r in rows]
                series = pd.Series(vals, index=idx, name=yahoo_symbol)

            covered = [(r[0], r[1]) for r in range_rows]
            return series, covered
        except Exception as exc:
            logger.warning("load_dividends DB error: %s", exc)
            return pd.Series(dtype="float64"), []


def _coalesce_ranges(conn, yahoo_symbol: str, kind: str, new_start: date, new_end: date) -> None:
    """Merge overlapping/adjacent coverage rows into one."""
    cur = conn.cursor()
    cur.execute(
        "SELECT range_start, range_end FROM ticker_fetch_ranges "
        "WHERE yahoo_symbol = %s AND kind = %s "
        "AND range_end >= %s AND range_start <= %s",
        (yahoo_symbol, kind, new_start - timedelta(days=1), new_end + timedelta(days=1)),
    )
    existing = cur.fetchall()
    all_starts = [r[0] for r in existing] + [new_start]
    all_ends = [r[1] for r in existing] + [new_end]
    merged_start = min(all_starts)
    merged_end = max(all_ends)
    if existing:
        cur.execute(
            "DELETE FROM ticker_fetch_ranges WHERE yahoo_symbol = %s AND kind = %s "
            "AND range_end >= %s AND range_start <= %s",
            (yahoo_symbol, kind, new_start - timedelta(days=1), new_end + timedelta(days=1)),
        )
    cur.execute(
        "INSERT INTO ticker_fetch_ranges (yahoo_symbol, kind, range_start, range_end) "
        "VALUES (%s, %s, %s, %s) ON CONFLICT (yahoo_symbol, kind, range_start) "
        "DO UPDATE SET range_end = EXCLUDED.range_end, fetched_at = now()",
        (yahoo_symbol, kind, merged_start, merged_end),
    )
    cur.close()


def save_prices(
    yahoo_symbol: str,
    series: pd.Series,
    range_start: date,
    range_end: date,
) -> None:
    """Persist price rows and update coverage range."""
    try:
        with _conn() as conn:
            if conn is None:
                return
            cur = conn.cursor()
            if not series.empty:
                rows = [
                    (yahoo_symbol, idx.date() if hasattr(idx, 'date') else idx, float(val))
                    for idx, val in series.items()
                    if not pd.isna(val)
                ]
                if rows:
                    cur.executemany(
                        "INSERT INTO ticker_prices (yahoo_symbol, price_date, close_price) "
                        "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                        rows,
                    )
            cur.close()
            _coalesce_ranges(conn, yahoo_symbol, 'price', range_start, range_end)
    except Exception as exc:
        logger.warning("save_prices DB error: %s", exc)


def save_dividends(
    yahoo_symbol: str,
    series: pd.Series,
    range_start: date,
    range_end: date,
) -> None:
    """Persist dividend rows and update coverage range."""
    try:
        with _conn() as conn:
            if conn is None:
                return
            cur = conn.cursor()
            if not series.empty:
                rows = [
                    (yahoo_symbol, idx.date() if hasattr(idx, 'date') else idx, float(val))
                    for idx, val in series.items()
                    if not pd.isna(val)
                ]
                if rows:
                    cur.executemany(
                        "INSERT INTO ticker_dividends (yahoo_symbol, ex_date, amount) "
                        "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                        rows,
                    )
            cur.close()
            _coalesce_ranges(conn, yahoo_symbol, 'dividend', range_start, range_end)
    except Exception as exc:
        logger.warning("save_dividends DB error: %s", exc)
