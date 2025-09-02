from __future__ import annotations
import numpy as np
import pandas as pd
from dateutil.relativedelta import relativedelta
from typing import Iterable


def compute_time_weighted_return(transactions: pd.DataFrame, prices: pd.DataFrame) -> float:
	"""Approximate TWR by chaining subperiod returns where external cashflows occur.

	BUY -> negative cashflow, SELL/DIV -> positive cashflow.
	"""
	df = transactions.copy()
	df = df.sort_values("date")

	# Define cashflows per date
	df["signed_cashflow"] = np.where(
		df["action"].isin(["SELL", "DIV"]),
		df["quantity"] * df["price"] - df.get("fees", 0.0),
		-(df["quantity"] * df["price"] + df.get("fees", 0.0)),
	)
	cashflows = df.groupby(df["date"].dt.normalize())["signed_cashflow"].sum()

	# Build daily portfolio value from positions and prices
	positions = (
		df.assign(signed_qty=np.where(df["action"] == "BUY", df["quantity"], -df["quantity"]))
		.groupby([df["date"].dt.normalize(), "ticker"])  # daily net
		["signed_qty"].sum()
		.unstack(fill_value=0)
		.reindex(columns=prices.columns, fill_value=0)
		.cumsum()
	)
	aligned_prices = prices.reindex(positions.index).ffill()
	portfolio_value = (positions * aligned_prices).sum(axis=1)

	# Identify valuation dates: all cashflow dates + ending date
	valuation_dates = sorted(set(cashflows.index.tolist() + [portfolio_value.index[-1]]))
	sub_returns = []
	prev_date = None
	for date in valuation_dates:
		if prev_date is None:
			prev_date = date
			continue
		start_val = portfolio_value.loc[prev_date]
		end_val = portfolio_value.loc[date]
		flow = cashflows.loc[prev_date:date].sum()
		if start_val + flow == 0:
			prev_date = date
			continue
		r = (end_val - (start_val + flow)) / (start_val + flow)
		sub_returns.append(r)
		prev_date = date

	if not sub_returns:
		return 0.0
	chain = float(np.prod([1 + r for r in sub_returns]) - 1)
	return chain


def _xnpv(rate: float, cashflows: Iterable[tuple[pd.Timestamp, float]]) -> float:
	cashflows = list(cashflows)
	if not cashflows:
		return 0.0
	dates = [d for d, _ in cashflows]
	amounts = [c for _, c in cashflows]
	start = min(dates)
	return float(
		sum(c / ((1 + rate) ** ((d - start).days / 365.0)) for d, c in cashflows)
	)


def _xirr(cashflows: Iterable[tuple[pd.Timestamp, float]], guess: float = 0.1) -> float:
	# Newton-Raphson
	rate = guess
	for _ in range(100):
		f = _xnpv(rate, cashflows)
		df = (_xnpv(rate + 1e-6, cashflows) - f) / 1e-6
		if abs(df) < 1e-12:
			break
		new_rate = rate - f / df
		if abs(new_rate - rate) < 1e-8:
			return float(new_rate)
		rate = new_rate
	return float(rate)


def compute_xirr(transactions: pd.DataFrame) -> float:
	df = transactions.copy()
	df = df.sort_values("date")
	df["signed_cashflow"] = np.where(
		df["action"].isin(["SELL", "DIV"]),
		df["quantity"] * df["price"] - df.get("fees", 0.0),
		-(df["quantity"] * df["price"] + df.get("fees", 0.0)),
	)
	cashflows = list(zip(pd.to_datetime(df["date"]).dt.tz_localize(None), df["signed_cashflow"].astype(float)))
	# Assume residual value is zero unless there is a final valuation step; for simplicity skip terminal value
	if not cashflows:
		return 0.0
	return _xirr(cashflows)
