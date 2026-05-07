from __future__ import annotations

from typing import Any

import pandas as pd

from .prices import fetch_prices_safely


def _sum_series(parts: list[pd.Series]) -> pd.Series:
    return parts[0] if len(parts) == 1 else pd.concat(parts, axis=1).ffill().fillna(0).sum(axis=1)


def _concat_frames(parts: list[pd.DataFrame]) -> pd.DataFrame:
    return parts[0] if len(parts) == 1 else pd.concat(parts, axis=1).ffill().fillna(0)


def compute_portfolio(
    transactions: pd.DataFrame,
    benchmark_tickers: list[str] | None = None,
) -> dict[str, Any]:
    """
    Compute portfolio metrics. Input transactions DataFrame must have columns:
    date, ticker, action, quantity, price, fees, exchange, portfolio, currency, net_amount.
    Returns JSON-serializable dict with portfolios, benchmarks, failed_tickers.
    """
    benchmark_tickers = benchmark_tickers or []

    portfolio_groups: dict[str, dict] = {}
    fetch_failures: list[str] = []

    for portfolio_name, file_df in transactions.groupby("portfolio"):
        _pv_parts: list[pd.Series] = []
        _nr_parts: list[pd.Series] = []
        _cr_parts: list[pd.Series] = []
        _dr_parts: list[pd.Series] = []
        _sv_parts: list[pd.DataFrame] = []
        _snr_parts: list[pd.DataFrame] = []
        _scr_parts: list[pd.DataFrame] = []
        _sdc_parts: list[pd.DataFrame] = []
        _disp_currency = "USD"

        for currency, group_df in file_df.groupby("currency"):
            exchange = group_df["exchange"].iloc[0]
            trade_rows = group_df[group_df["action"].isin(["BUY", "SELL"])]
            if trade_rows.empty:
                continue

            tickers = sorted(trade_rows["ticker"].dropna().unique().tolist())
            start_date = trade_rows["date"].min().normalize()
            end_date = pd.Timestamp.today().normalize() + pd.Timedelta(days=1)

            prices, failed_tickers = fetch_prices_safely(tickers, exchange, start_date, end_date)

            if failed_tickers:
                fetch_failures.extend(f"{portfolio_name} ({currency}): {t}" for t in failed_tickers)
                continue

            if prices.empty:
                fetch_failures.append(f"{portfolio_name} ({currency}): no price data")
                continue

            prices = prices.ffill()

            trade_rows = trade_rows.copy()
            trade_rows["signed_qty"] = trade_rows.apply(
                lambda r: r["quantity"] if r["action"] == "BUY" else -r["quantity"], axis=1
            )
            positions = (
                trade_rows.groupby([trade_rows["date"].dt.normalize(), "ticker"])["signed_qty"]
                .sum()
                .unstack(fill_value=0)
                .reindex(columns=prices.columns, fill_value=0)
                .cumsum()
                .reindex(prices.index, method="ffill")
                .fillna(0)
            )

            symbol_values = positions * prices
            portfolio_value = symbol_values.sum(axis=1)

            symbol_cashflows = pd.DataFrame(index=prices.index)
            for ticker in prices.columns:
                mask = group_df["ticker"] == ticker
                symbol_cashflows[ticker] = (
                    group_df[mask]
                    .groupby(group_df[mask]["date"].dt.normalize())["net_amount"]
                    .sum()
                    .cumsum()
                    .reindex(prices.index, method="ffill")
                    .fillna(0)
                )
            symbol_net_returns = symbol_values + symbol_cashflows

            total_cashflows = symbol_cashflows.sum(axis=1)
            net_return = portfolio_value + total_cashflows

            symbol_div_cashflows = pd.DataFrame(index=prices.index)
            for ticker in prices.columns:
                mask_div = (group_df["ticker"] == ticker) & (group_df["action"] == "DIV")
                symbol_div_cashflows[ticker] = (
                    group_df[mask_div]
                    .groupby(group_df[mask_div]["date"].dt.normalize())["net_amount"]
                    .sum()
                    .cumsum()
                    .reindex(prices.index, method="ffill")
                    .fillna(0)
                )
            symbol_capital_returns = symbol_net_returns - symbol_div_cashflows
            total_div_cashflows = symbol_div_cashflows.sum(axis=1)
            capital_return = net_return - total_div_cashflows

            if currency == "AUD":
                fx_df, fx_failed = _fetch_prices_safely(["AUDUSD=X"], "US", start_date, end_date)
                if fx_failed or fx_df.empty:
                    _disp_currency = "AUD"
                else:
                    fx_rate = fx_df["AUDUSD=X"].reindex(prices.index, method="ffill").bfill()
                    portfolio_value = portfolio_value * fx_rate
                    net_return = net_return * fx_rate
                    symbol_values = symbol_values.multiply(fx_rate, axis=0)
                    symbol_net_returns = symbol_net_returns.multiply(fx_rate, axis=0)
                    capital_return = capital_return * fx_rate
                    total_div_cashflows = total_div_cashflows * fx_rate
                    symbol_capital_returns = symbol_capital_returns.multiply(fx_rate, axis=0)
                    symbol_div_cashflows = symbol_div_cashflows.multiply(fx_rate, axis=0)
                    _disp_currency = "USD"
            else:
                _disp_currency = "USD"

            _pv_parts.append(portfolio_value)
            _nr_parts.append(net_return)
            _cr_parts.append(capital_return)
            _dr_parts.append(total_div_cashflows)
            _sv_parts.append(symbol_values)
            _snr_parts.append(symbol_net_returns)
            _scr_parts.append(symbol_capital_returns)
            _sdc_parts.append(symbol_div_cashflows)

        if not _pv_parts:
            continue

        portfolio_groups[str(portfolio_name)] = {
            "portfolio_value": _sum_series(_pv_parts),
            "net_return": _sum_series(_nr_parts),
            "capital_return": _sum_series(_cr_parts),
            "dividend_return": _sum_series(_dr_parts),
            "symbol_values": _concat_frames(_sv_parts),
            "symbol_net_returns": _concat_frames(_snr_parts),
            "symbol_capital_returns": _concat_frames(_scr_parts),
            "symbol_div_cashflows": _concat_frames(_sdc_parts),
            "display_currency": _disp_currency,
        }

    benchmark_data: dict[str, Any] = {}
    if benchmark_tickers and portfolio_groups:
        bm_start = min(grp["portfolio_value"].index[0] for grp in portfolio_groups.values())
        bm_end = pd.Timestamp.today().normalize() + pd.Timedelta(days=1)
        bm_prices, _ = fetch_prices_safely(benchmark_tickers, "US", bm_start, bm_end)
        for bm in benchmark_tickers:
            if bm in bm_prices.columns:
                s = bm_prices[bm].dropna()
                benchmark_data[bm] = {
                    "dates": s.index.strftime("%Y-%m-%d").tolist(),
                    "values": [float(v) for v in s],
                }

    result_portfolios: dict[str, Any] = {}
    for name, grp in portfolio_groups.items():
        pv = grp["portfolio_value"]
        sv = grp["symbol_values"]
        snr = grp["symbol_net_returns"]
        scr = grp["symbol_capital_returns"]
        sdc = grp["symbol_div_cashflows"]

        symbols: dict[str, Any] = {}
        for ticker in sv.columns:
            symbols[str(ticker)] = {
                "value": [float(v) for v in sv[ticker]],
                "net_return": [float(v) for v in snr[ticker]] if ticker in snr.columns else [],
                "capital_return": [float(v) for v in scr[ticker]] if ticker in scr.columns else [],
                "div_cashflow": [float(v) for v in sdc[ticker]] if ticker in sdc.columns else [],
            }

        result_portfolios[name] = {
            "dates": pv.index.strftime("%Y-%m-%d").tolist(),
            "portfolio_value": [float(v) for v in pv],
            "net_return": [float(v) for v in grp["net_return"]],
            "capital_return": [float(v) for v in grp["capital_return"]],
            "dividend_return": [float(v) for v in grp["dividend_return"]],
            "display_currency": grp["display_currency"],
            "symbols": symbols,
        }

    return {
        "portfolios": result_portfolios,
        "benchmarks": benchmark_data,
        "failed_tickers": fetch_failures,
    }
