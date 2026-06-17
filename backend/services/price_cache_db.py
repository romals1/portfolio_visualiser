from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import pandas as pd

from . import db

logger = logging.getLogger(__name__)

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


db_available = db.db_available


def _expand_in(sql: str, values: list, params: list) -> tuple[str, list]:
    """Replace = ANY(%s) with IN (?, ?, ...) for SQLite.

    For Postgres this is a no-op (psycopg2 handles ANY natively).
    """
    if db.is_postgres:
        return sql, params
    placeholders = ", ".join(["?"] * len(values))
    sql = sql.replace("= ANY(%s)", f"IN ({placeholders})")
    return sql, params


def gaps(
    req_start: date,
    req_end: date,
    covered: list[tuple[date, date]],
) -> list[tuple[date, date]]:
    """Return sub-ranges of [req_start, req_end) not covered by the given intervals."""
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
    """Load cached prices for many symbols."""
    if not yahoo_symbols:
        return {}, {}
    try:
        with db.get_conn() as conn:
            cur = conn.cursor()
            end_incl = end - timedelta(days=1)

            price_sql = (
                "SELECT yahoo_symbol, price_date, close_price FROM ticker_prices "
                "WHERE yahoo_symbol = ANY(%s) AND price_date >= %s AND price_date <= %s "
                "ORDER BY yahoo_symbol, price_date"
            )
            range_sql = (
                "SELECT yahoo_symbol, range_start, range_end FROM ticker_fetch_ranges "
                "WHERE yahoo_symbol = ANY(%s) AND kind = 'price' "
                "AND range_end >= %s AND range_start <= %s"
            )

            price_sql, _ = _expand_in(price_sql, yahoo_symbols, [])
            range_sql, _ = _expand_in(range_sql, yahoo_symbols, [])

            params = yahoo_symbols + [start, end_incl]
            db.db_execute(cur, price_sql, tuple(params))
            price_rows = cur.fetchall()
            db.db_execute(cur, range_sql, tuple(params))
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
    """Load cached dividends for many symbols."""
    if not yahoo_symbols:
        return {}, {}
    try:
        with db.get_conn() as conn:
            cur = conn.cursor()
            end_incl = end - timedelta(days=1)

            div_sql = (
                "SELECT yahoo_symbol, ex_date, amount FROM ticker_dividends "
                "WHERE yahoo_symbol = ANY(%s) AND ex_date >= %s AND ex_date <= %s "
                "ORDER BY yahoo_symbol, ex_date"
            )
            range_sql = (
                "SELECT yahoo_symbol, range_start, range_end FROM ticker_fetch_ranges "
                "WHERE yahoo_symbol = ANY(%s) AND kind = 'dividend' "
                "AND range_end >= %s AND range_start <= %s"
            )

            div_sql, _ = _expand_in(div_sql, yahoo_symbols, [])
            range_sql, _ = _expand_in(range_sql, yahoo_symbols, [])

            params = yahoo_symbols + [start, end_incl]
            db.db_execute(cur, div_sql, tuple(params))
            div_rows = cur.fetchall()
            db.db_execute(cur, range_sql, tuple(params))
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
    db.db_execute(
        cur,
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
        db.db_execute(
            cur,
            "DELETE FROM ticker_fetch_ranges WHERE yahoo_symbol = %s AND kind = %s "
            "AND range_end >= %s AND range_start <= %s",
            (yahoo_symbol, kind, new_start - timedelta(days=1), new_end + timedelta(days=1)),
        )
    db.db_execute(
        cur,
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
        with db.get_conn() as conn:
            cur = conn.cursor()
            if not series.empty:
                rows = [
                    (yahoo_symbol, idx.date() if hasattr(idx, 'date') else idx, float(val))
                    for idx, val in series.items()
                    if not pd.isna(val)
                ]
                if rows:
                    db.execute_values(
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
        with db.get_conn() as conn:
            cur = conn.cursor()
            if not series.empty:
                rows = [
                    (yahoo_symbol, idx.date() if hasattr(idx, 'date') else idx, float(val))
                    for idx, val in series.items()
                    if not pd.isna(val)
                ]
                if rows:
                    db.execute_values(
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
