from __future__ import annotations

import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import date, timedelta
from typing import Generator

import pandas as pd

logger = logging.getLogger(__name__)

_POOL = None
_POOL_LOCK = threading.Lock()
_DB_DISABLED = False

_SAVE_EXECUTOR: ThreadPoolExecutor | None = None
_SAVE_EXECUTOR_LOCK = threading.Lock()


def _get_save_executor() -> ThreadPoolExecutor:
    global _SAVE_EXECUTOR
    if _SAVE_EXECUTOR is not None:
        return _SAVE_EXECUTOR
    with _SAVE_EXECUTOR_LOCK:
        if _SAVE_EXECUTOR is None:
            _SAVE_EXECUTOR = ThreadPoolExecutor(
                max_workers=2, thread_name_prefix="price-cache-save"
            )
        return _SAVE_EXECUTOR


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


def load_prices_batch(
    yahoo_symbols: list[str],
    start: date,
    end: date,
) -> tuple[dict[str, pd.Series], dict[str, list[tuple[date, date]]]]:
    """Load cached prices for many symbols in two SQL roundtrips.

    Returns ({symbol: Series}, {symbol: [(range_start, range_end), ...]}). Missing
    symbols simply absent from the returned dicts. end is exclusive.
    """
    if not yahoo_symbols:
        return {}, {}
    with _conn() as conn:
        if conn is None:
            return {}, {}
        try:
            cur = conn.cursor()
            end_incl = end - timedelta(days=1)
            cur.execute(
                "SELECT yahoo_symbol, price_date, close_price FROM ticker_prices "
                "WHERE yahoo_symbol = ANY(%s) AND price_date >= %s AND price_date <= %s "
                "ORDER BY yahoo_symbol, price_date",
                (yahoo_symbols, start, end_incl),
            )
            price_rows = cur.fetchall()
            cur.execute(
                "SELECT yahoo_symbol, range_start, range_end FROM ticker_fetch_ranges "
                "WHERE yahoo_symbol = ANY(%s) AND kind = 'price' "
                "AND range_end >= %s AND range_start <= %s",
                (yahoo_symbols, start, end_incl),
            )
            range_rows = cur.fetchall()
            cur.close()

            grouped: dict[str, list[tuple]] = {}
            for sym, dt, price in price_rows:
                grouped.setdefault(sym, []).append((dt, float(price)))
            series_map: dict[str, pd.Series] = {}
            for sym, items in grouped.items():
                idx = pd.to_datetime([r[0] for r in items])
                vals = [r[1] for r in items]
                series_map[sym] = pd.Series(vals, index=idx, name=sym)

            covered_map: dict[str, list[tuple[date, date]]] = {}
            for sym, rs, re_ in range_rows:
                covered_map.setdefault(sym, []).append((rs, re_))

            return series_map, covered_map
        except Exception as exc:
            logger.warning("load_prices_batch DB error: %s", exc)
            return {}, {}


def load_dividends_batch(
    yahoo_symbols: list[str],
    start: date,
    end: date,
) -> tuple[dict[str, pd.Series], dict[str, list[tuple[date, date]]]]:
    """Load cached dividends for many symbols in two SQL roundtrips.

    Returns ({symbol: Series}, {symbol: [(range_start, range_end), ...]}). end is exclusive.
    Symbols with no rows still appear in covered_map if they have a coverage record
    (i.e. fetched but pay no dividends in window).
    """
    if not yahoo_symbols:
        return {}, {}
    with _conn() as conn:
        if conn is None:
            return {}, {}
        try:
            cur = conn.cursor()
            end_incl = end - timedelta(days=1)
            cur.execute(
                "SELECT yahoo_symbol, ex_date, amount FROM ticker_dividends "
                "WHERE yahoo_symbol = ANY(%s) AND ex_date >= %s AND ex_date <= %s "
                "ORDER BY yahoo_symbol, ex_date",
                (yahoo_symbols, start, end_incl),
            )
            div_rows = cur.fetchall()
            cur.execute(
                "SELECT yahoo_symbol, range_start, range_end FROM ticker_fetch_ranges "
                "WHERE yahoo_symbol = ANY(%s) AND kind = 'dividend' "
                "AND range_end >= %s AND range_start <= %s",
                (yahoo_symbols, start, end_incl),
            )
            range_rows = cur.fetchall()
            cur.close()

            grouped: dict[str, list[tuple]] = {}
            for sym, dt, amt in div_rows:
                grouped.setdefault(sym, []).append((dt, float(amt)))
            series_map: dict[str, pd.Series] = {}
            for sym, items in grouped.items():
                idx = pd.to_datetime([r[0] for r in items])
                vals = [r[1] for r in items]
                series_map[sym] = pd.Series(vals, index=idx, name=sym)

            covered_map: dict[str, list[tuple[date, date]]] = {}
            for sym, rs, re_ in range_rows:
                covered_map.setdefault(sym, []).append((rs, re_))

            return series_map, covered_map
        except Exception as exc:
            logger.warning("load_dividends_batch DB error: %s", exc)
            return {}, {}


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
        from psycopg2.extras import execute_values

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
                    execute_values(
                        cur,
                        "INSERT INTO ticker_prices (yahoo_symbol, price_date, close_price) "
                        "VALUES %s ON CONFLICT DO NOTHING",
                        rows,
                        page_size=1000,
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
        from psycopg2.extras import execute_values

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
                    execute_values(
                        cur,
                        "INSERT INTO ticker_dividends (yahoo_symbol, ex_date, amount) "
                        "VALUES %s ON CONFLICT DO NOTHING",
                        rows,
                        page_size=1000,
                    )
            cur.close()
            _coalesce_ranges(conn, yahoo_symbol, 'dividend', range_start, range_end)
    except Exception as exc:
        logger.warning("save_dividends DB error: %s", exc)


def save_prices_async(
    yahoo_symbol: str,
    series: pd.Series,
    range_start: date,
    range_end: date,
) -> None:
    """Fire-and-forget variant of save_prices; runs on a background thread."""
    _get_save_executor().submit(save_prices, yahoo_symbol, series, range_start, range_end)


def save_dividends_async(
    yahoo_symbol: str,
    series: pd.Series,
    range_start: date,
    range_end: date,
) -> None:
    """Fire-and-forget variant of save_dividends; runs on a background thread."""
    _get_save_executor().submit(save_dividends, yahoo_symbol, series, range_start, range_end)
