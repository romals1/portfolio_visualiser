from __future__ import annotations

import time
from datetime import date as date_t
from threading import Lock

import pandas as pd
import yfinance as yf

_PRICE_CACHE: dict[tuple, tuple[float, pd.Series]] = {}
_FAILURE_CACHE: dict[tuple, float] = {}
_CACHE_LOCK = Lock()
_SUCCESS_TTL_S = 6 * 3600
_FAILURE_BACKOFF_S = 300


def yahoo_symbol(ticker: str, exchange: str) -> str:
    return f"{ticker}.AX" if exchange == "ASX" else ticker


def _fetch_batch_from_yfinance(
    yahoo_symbols: list[str],
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> tuple[dict[str, pd.Series], dict[str, pd.Series], list[str]]:
    """Fetch raw close prices and dividends for many Yahoo tickers in one HTTP call.

    Uses yf.download(actions=True) to retrieve both prices and dividend events in a
    single batched request. Returns (prices_by_symbol, dividends_by_symbol, failed),
    where failed contains symbols with no usable price data. end is exclusive (yfinance
    semantics) — callers pass last_date + 1 day.

    auto_adjust=False so historical close reflects actual market value; dividends are
    surfaced as separate events to be added as explicit cashflows downstream (avoids
    the double-count of auto_adjust=True folding dividends into the price).
    """
    if not yahoo_symbols:
        return {}, {}, []

    start = pd.to_datetime(start).tz_localize(None).normalize()
    end = pd.to_datetime(end).tz_localize(None).normalize()

    df = yf.download(
        tickers=yahoo_symbols,
        start=start,
        end=end,
        auto_adjust=False,
        actions=True,
        progress=False,
        group_by="column",
        threads=True,
    )

    if df is None or df.empty:
        return {}, {}, list(yahoo_symbols)

    # With a list input, yf.download returns a MultiIndex (Field, Ticker).
    if not isinstance(df.columns, pd.MultiIndex):
        # Defensive: coerce to MultiIndex for the single-ticker path.
        df.columns = pd.MultiIndex.from_product([df.columns, [yahoo_symbols[0]]])

    df.index = pd.to_datetime(df.index).tz_localize(None).normalize()

    close_df = df["Close"] if "Close" in df.columns.get_level_values(0) else pd.DataFrame()
    div_df = df["Dividends"] if "Dividends" in df.columns.get_level_values(0) else pd.DataFrame()

    prices: dict[str, pd.Series] = {}
    divs: dict[str, pd.Series] = {}
    failed: list[str] = []

    for ys in yahoo_symbols:
        close = close_df[ys].dropna() if ys in close_df.columns else pd.Series(dtype="float64")
        if close.empty:
            failed.append(ys)
        else:
            close.name = ys
            prices[ys] = close

        if ys in div_df.columns:
            d = div_df[ys].dropna()
            d = d[d > 0]
        else:
            d = pd.Series(dtype="float64")
        d.name = ys
        divs[ys] = d  # may be empty — valid result for tickers that paid no dividends

    return prices, divs, failed


def fetch_prices_and_dividends_safely(
    items: list[tuple[str, str]],
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> tuple[dict[str, pd.Series], dict[str, pd.Series], list[str]]:
    """Batched fetch of prices + dividends across tickers (possibly mixed exchanges).

    items: list of (ticker, exchange) tuples; exchange is "ASX" or "US".

    Pipeline:
      1. In-memory cache check for each symbol (separate keys for price/div).
      2. Single batched DB load for all symbols missing from the in-memory cache.
      3. Compute per-symbol gaps; collect symbols that still need to hit yfinance.
      4. One yf.download call with actions=True over the union of gap windows.
      5. Async-persist new data per symbol; refresh in-memory cache.

    Returns ({original_ticker: prices Series}, {original_ticker: dividends Series},
    failed_original_tickers). Dividend failures are silent (empty Series). Returned
    series are named by the original (non-Yahoo) ticker.
    """
    if not items:
        return {}, {}, []

    yahoo_to_original: dict[str, str] = {}
    for ticker, exchange in items:
        ys = yahoo_symbol(ticker, exchange)
        # If two inputs map to the same yahoo symbol, the later wins — fine for our use.
        yahoo_to_original[ys] = ticker

    all_symbols = list(yahoo_to_original.keys())
    range_key = (str(start), str(end))
    now = time.time()

    cached_px: dict[str, pd.Series] = {}
    cached_div: dict[str, pd.Series] = {}
    need_px_symbols: list[str] = []
    need_div_symbols: list[str] = []
    px_recent_failure: set[str] = set()

    with _CACHE_LOCK:
        for ys in all_symbols:
            px_key = ("PX", ys, *range_key)
            div_key = ("DIV", ys, *range_key)

            last_fail = _FAILURE_CACHE.get(px_key)
            if last_fail is not None and (now - last_fail) < _FAILURE_BACKOFF_S:
                px_recent_failure.add(ys)
            else:
                px = _PRICE_CACHE.get(px_key)
                if px is not None and (now - px[0]) < _SUCCESS_TTL_S:
                    cached_px[ys] = px[1].copy()
                else:
                    need_px_symbols.append(ys)

            dv = _PRICE_CACHE.get(div_key)
            if dv is not None and (now - dv[0]) < _SUCCESS_TTL_S:
                cached_div[ys] = dv[1].copy()
            else:
                need_div_symbols.append(ys)

    from .price_cache_db import (
        db_available,
        load_dividends_batch,
        load_prices_batch,
        save_dividends_async,
        save_prices_async,
    )
    from .price_cache_db import (
        gaps as compute_gaps,
    )

    req_start: date_t = pd.Timestamp(start).date()
    req_end: date_t = pd.Timestamp(end).date()

    db_px: dict[str, pd.Series] = {}
    db_px_covered: dict[str, list[tuple[date_t, date_t]]] = {}
    db_div: dict[str, pd.Series] = {}
    db_div_covered: dict[str, list[tuple[date_t, date_t]]] = {}

    if db_available():
        if need_px_symbols:
            db_px, db_px_covered = load_prices_batch(need_px_symbols, req_start, req_end)
        if need_div_symbols:
            db_div, db_div_covered = load_dividends_batch(need_div_symbols, req_start, req_end)

    db_on = db_available()
    px_gaps: dict[str, list[tuple[date_t, date_t]]] = {}
    for ys in need_px_symbols:
        if db_on:
            px_gaps[ys] = compute_gaps(req_start, req_end, db_px_covered.get(ys, []))
        else:
            px_gaps[ys] = [(req_start, req_end)]

    div_gaps: dict[str, list[tuple[date_t, date_t]]] = {}
    for ys in need_div_symbols:
        if db_on:
            div_gaps[ys] = compute_gaps(req_start, req_end, db_div_covered.get(ys, []))
        else:
            div_gaps[ys] = [(req_start, req_end)]

    symbols_to_fetch: set[str] = set()
    for ys, g in px_gaps.items():
        if g:
            symbols_to_fetch.add(ys)
    for ys, g in div_gaps.items():
        if g:
            symbols_to_fetch.add(ys)

    fetched_px: dict[str, pd.Series] = {}
    fetched_div: dict[str, pd.Series] = {}
    fetch_fail: set[str] = set()
    fetch_start: date_t | None = None
    fetch_end: date_t | None = None

    if symbols_to_fetch:
        gap_starts: list[date_t] = []
        gap_ends: list[date_t] = []
        for ys in symbols_to_fetch:
            for gs, ge in px_gaps.get(ys, []) + div_gaps.get(ys, []):
                gap_starts.append(gs)
                gap_ends.append(ge)
        fetch_start = min(gap_starts)
        fetch_end = max(gap_ends)

        try:
            fetched_px, fetched_div, batch_failed = _fetch_batch_from_yfinance(
                list(symbols_to_fetch),
                pd.Timestamp(fetch_start),
                pd.Timestamp(fetch_end) + pd.Timedelta(days=1),
            )
            fetch_fail.update(batch_failed)
        except Exception:
            # Total HTTP-level failure — every symbol in this batch is a fetch failure.
            fetch_fail.update(symbols_to_fetch)

        if db_available() and fetch_start is not None and fetch_end is not None:
            for ys in symbols_to_fetch:
                if ys in fetch_fail:
                    # Don't claim coverage we didn't get.
                    continue
                # Persist whatever we got for this symbol over the fetched window;
                # an empty dividend Series with a coverage range correctly records
                # "we asked, ticker paid nothing in this window".
                save_prices_async(ys, fetched_px.get(ys, pd.Series(dtype="float64")), fetch_start, fetch_end)
                save_dividends_async(ys, fetched_div.get(ys, pd.Series(dtype="float64")), fetch_start, fetch_end)

    final_prices: dict[str, pd.Series] = {}
    final_divs: dict[str, pd.Series] = {}
    failed_originals: list[str] = []

    for ys in all_symbols:
        original = yahoo_to_original[ys]
        px_key = ("PX", ys, *range_key)
        div_key = ("DIV", ys, *range_key)

        price_ok = False
        # Prices
        if ys in px_recent_failure:
            failed_originals.append(original)
        elif ys in cached_px:
            s = cached_px[ys].copy()
            s.name = original
            final_prices[original] = s
            price_ok = True
        else:
            parts: list[pd.Series] = []
            db_s = db_px.get(ys, pd.Series(dtype="float64"))
            if not db_s.empty:
                parts.append(db_s)
            if ys in fetched_px:
                parts.append(fetched_px[ys])

            if parts:
                combined = pd.concat(parts).sort_index()
                combined = combined[~combined.index.duplicated(keep="last")]
                with _CACHE_LOCK:
                    _PRICE_CACHE[px_key] = (time.time(), combined.copy())
                combined.name = original
                final_prices[original] = combined
                price_ok = True
            elif ys in fetch_fail:
                with _CACHE_LOCK:
                    _FAILURE_CACHE[px_key] = time.time()
                failed_originals.append(original)
            else:
                # No data, no failure: treat as failure but don't poison the backoff cache.
                failed_originals.append(original)

        # Always populate the in-memory dividend cache (even for failed-price tickers
        # and tickers that pay nothing) so subsequent calls don't re-fetch. Only the
        # return value suppresses dividends for failed-price tickers, matching the
        # pre-batch router behavior.
        if ys in cached_div:
            d = cached_div[ys].copy()
        else:
            parts = []
            db_s = db_div.get(ys, pd.Series(dtype="float64"))
            if not db_s.empty:
                parts.append(db_s)
            if ys in fetched_div:
                parts.append(fetched_div[ys])

            if parts:
                d = pd.concat(parts).sort_index()
                d = d[~d.index.duplicated(keep="last")]
            else:
                d = pd.Series(dtype="float64")

            with _CACHE_LOCK:
                _PRICE_CACHE[div_key] = (time.time(), d.copy())

        if price_ok:
            d.name = original
            final_divs[original] = d

    return final_prices, final_divs, failed_originals


def clear_price_caches() -> None:
    with _CACHE_LOCK:
        _PRICE_CACHE.clear()
        _FAILURE_CACHE.clear()
