from __future__ import annotations

import time
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


def fetch_one_price_series(
    yahoo_ticker: str,
    start: pd.Timestamp | str | None = None,
    end: pd.Timestamp | str | None = None,
) -> pd.Series:
    """Fetch raw (unadjusted) close prices for a single Yahoo ticker.

    Returns a tz-naive, daily-normalized Series. Raises RuntimeError if no data
    is returned (empty response, missing Close column, or all-NaN). end is
    exclusive in yfinance; callers should pass last_date + 1 day.

    auto_adjust=False so historical close prices reflect actual market value.
    Dividends are fetched separately via fetch_one_dividend_series and added as
    explicit cashflows in the return calculation; combining unadjusted prices
    with explicit dividend cashflows avoids the double-count that would result
    from using auto_adjust=True (which folds dividends into the price series).
    """
    if start is not None:
        start = pd.to_datetime(start).tz_localize(None).normalize()
    if end is not None:
        end = pd.to_datetime(end).tz_localize(None).normalize()

    df = yf.download(
        tickers=yahoo_ticker,
        start=start,
        end=end,
        auto_adjust=False,
        progress=False,
    )
    if df.empty:
        raise RuntimeError(f"No price data returned for {yahoo_ticker}")

    if isinstance(df.columns, pd.MultiIndex):
        # yfinance returns MultiIndex (Field, Ticker) with Field on level 0.
        if "Close" not in df.columns.get_level_values(0):
            raise RuntimeError(f"No Close column for {yahoo_ticker}")
        sub = df["Close"]
        s = sub.iloc[:, 0] if isinstance(sub, pd.DataFrame) else sub
    else:
        if "Close" not in df.columns:
            raise RuntimeError(f"No Close column for {yahoo_ticker}")
        s = df["Close"]

    s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
    s = s.dropna()
    if s.empty:
        raise RuntimeError(f"All-NaN price data for {yahoo_ticker}")
    s.name = yahoo_ticker
    return s


def fetch_one_dividend_series(
    yahoo_ticker: str,
    start: pd.Timestamp | str | None = None,
    end: pd.Timestamp | str | None = None,
) -> pd.Series:
    """Fetch per-share dividend events for a single Yahoo ticker.

    Returns a tz-naive Series indexed by ex-dividend date with per-share dividend
    amount (in the ticker's local currency) as values. Returns an empty Series
    if the ticker pays no dividends in the window — this is not an error.
    """
    if start is not None:
        start = pd.to_datetime(start).tz_localize(None).normalize()
    if end is not None:
        end = pd.to_datetime(end).tz_localize(None).normalize()

    s = yf.Ticker(yahoo_ticker).dividends
    if s is None or s.empty:
        return pd.Series(dtype="float64", name=yahoo_ticker, index=pd.DatetimeIndex([]))
    s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
    if start is not None:
        s = s[s.index >= start]
    if end is not None:
        # match price end semantics (exclusive)
        s = s[s.index < end]
    s.name = yahoo_ticker
    return s


def _fetch_cached(yahoo_ticker: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.Series:
    key = ("PX", yahoo_ticker, str(start), str(end))
    now = time.time()
    with _CACHE_LOCK:
        last_fail = _FAILURE_CACHE.get(key)
        if last_fail is not None and (now - last_fail) < _FAILURE_BACKOFF_S:
            remaining = int(_FAILURE_BACKOFF_S - (now - last_fail))
            raise RuntimeError(f"{yahoo_ticker}: backing off (retry in {remaining}s)")
        cached = _PRICE_CACHE.get(key)
        if cached is not None:
            cached_time, series = cached
            if now - cached_time < _SUCCESS_TTL_S:
                return series.copy()
    series = fetch_one_price_series(yahoo_ticker, start=start, end=end)
    with _CACHE_LOCK:
        _PRICE_CACHE[key] = (time.time(), series)
    return series


def _fetch_cached_dividends(yahoo_ticker: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.Series:
    key = ("DIV", yahoo_ticker, str(start), str(end))
    now = time.time()
    with _CACHE_LOCK:
        last_fail = _FAILURE_CACHE.get(key)
        if last_fail is not None and (now - last_fail) < _FAILURE_BACKOFF_S:
            remaining = int(_FAILURE_BACKOFF_S - (now - last_fail))
            raise RuntimeError(f"{yahoo_ticker}: dividend backing off (retry in {remaining}s)")
        cached = _PRICE_CACHE.get(key)
        if cached is not None:
            cached_time, series = cached
            if now - cached_time < _SUCCESS_TTL_S:
                return series.copy()
    try:
        series = fetch_one_dividend_series(yahoo_ticker, start=start, end=end)
    except Exception:
        with _CACHE_LOCK:
            _FAILURE_CACHE[key] = time.time()
        raise
    with _CACHE_LOCK:
        _PRICE_CACHE[key] = (time.time(), series)
    return series


def fetch_prices_safely(
    tickers: list[str],
    exchange: str,
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> tuple[pd.DataFrame, list[str]]:
    series_map: dict[str, pd.Series] = {}
    failed: list[str] = []
    for t in tickers:
        ys = yahoo_symbol(t, exchange)
        try:
            series_map[t] = _fetch_cached(ys, start, end)
        except Exception:
            failed.append(t)
    if not series_map:
        return pd.DataFrame(), failed
    df = pd.concat(series_map, axis=1).sort_index().dropna(how="all")
    return df, failed


def fetch_dividends_safely(
    tickers: list[str],
    exchange: str,
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> dict[str, pd.Series]:
    """Fetch per-share dividend series for each ticker.

    Returns {ticker: Series}. Empty Series for tickers with no dividends or
    on fetch failure (failures are silent — dividends are best-effort).
    """
    out: dict[str, pd.Series] = {}
    for t in tickers:
        ys = yahoo_symbol(t, exchange)
        try:
            out[t] = _fetch_cached_dividends(ys, start, end)
        except Exception:
            out[t] = pd.Series(dtype="float64", name=t)
    return out


def clear_price_caches() -> None:
    with _CACHE_LOCK:
        _PRICE_CACHE.clear()
        _FAILURE_CACHE.clear()
