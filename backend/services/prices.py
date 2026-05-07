from __future__ import annotations

import pandas as pd
import yfinance as yf


def yahoo_symbol(ticker: str, exchange: str) -> str:
    return f"{ticker}.AX" if exchange == "ASX" else ticker


def fetch_one_price_series(
    yahoo_ticker: str,
    start: pd.Timestamp | str | None = None,
    end: pd.Timestamp | str | None = None,
) -> pd.Series:
    """Fetch adjusted close prices for a single Yahoo ticker.

    Returns a tz-naive, daily-normalized Series. Raises RuntimeError if no data
    is returned (empty response, missing Close column, or all-NaN). end is
    exclusive in yfinance; callers should pass last_date + 1 day.
    """
    if start is not None:
        start = pd.to_datetime(start).tz_localize(None).normalize()
    if end is not None:
        end = pd.to_datetime(end).tz_localize(None).normalize()

    df = yf.download(
        tickers=yahoo_ticker,
        start=start,
        end=end,
        auto_adjust=True,
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
