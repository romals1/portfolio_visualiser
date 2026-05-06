from __future__ import annotations

import pandas as pd
import yfinance as yf


def yahoo_symbol(ticker: str, exchange: str) -> str:
    return f"{ticker}.AX" if exchange == "ASX" else ticker


def fetch_prices_for_tickers(
    tickers: list[str],
    exchange: str,
    start: pd.Timestamp | str | None = None,
    end: pd.Timestamp | str | None = None,
) -> pd.DataFrame:
    """Fetch adjusted close prices for tickers as a wide DataFrame.

    Returns columns keyed by the original ticker symbol (no .AX suffix).
    end is exclusive in yfinance; callers should pass last_date + 1 day.
    """
    if not tickers:
        return pd.DataFrame()

    if start is not None:
        start = pd.to_datetime(start).tz_localize(None).normalize()
    if end is not None:
        end = pd.to_datetime(end).tz_localize(None).normalize()

    yahoo_tickers = [yahoo_symbol(t, exchange) for t in tickers]
    ticker_map = dict(zip(yahoo_tickers, tickers))  # yahoo → original

    data = yf.download(
        tickers=yahoo_tickers,
        start=start,
        end=end,
        auto_adjust=True,
        progress=False,
        group_by="ticker",
    )

    if data.empty:
        return pd.DataFrame()

    if isinstance(data.columns, pd.MultiIndex):
        adj_close = data.loc[:, (slice(None), "Close")].copy()
        adj_close.columns = [ticker_map.get(c[0], c[0]) for c in adj_close.columns]
    else:
        yt = yahoo_tickers[0]
        adj_close = data[["Close"]].rename(columns={"Close": ticker_map.get(yt, tickers[0])})

    adj_close.index = pd.to_datetime(adj_close.index).tz_localize(None).normalize()
    return adj_close.sort_index().dropna(how="all")
