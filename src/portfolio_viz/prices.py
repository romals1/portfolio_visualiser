from typing import List
import pandas as pd
import yfinance as yf


def fetch_prices_for_tickers(tickers: List[str]) -> pd.DataFrame:
	"""Fetch adjusted close prices for tickers as a wide DataFrame."""
	if not tickers:
		return pd.DataFrame()
	data = yf.download(tickers=tickers, auto_adjust=True, progress=False, group_by="ticker")
	# Normalize to wide date index with columns per ticker
	if isinstance(data.columns, pd.MultiIndex):
		adj_close = data.loc[:, (slice(None), "Close")]
		adj_close.columns = [c[0] for c in adj_close.columns]
	else:
		adj_close = data.rename(columns={"Close": tickers[0]})[[tickers[0]]]
	adj_close = adj_close.sort_index().dropna(how="all")
	return adj_close
