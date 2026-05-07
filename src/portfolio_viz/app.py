import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

SRC_DIR = Path(__file__).resolve().parents[1]
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from portfolio_viz.auth import get_client  # noqa: E402
from portfolio_viz.data import _detect_format, load_transactions  # noqa: E402
from portfolio_viz.prices import fetch_one_price_series, yahoo_symbol  # noqa: E402

# Process-wide backoff for failed ticker fetches. Successful fetches use
# st.cache_data with a long TTL; failures aren't cached by st.cache_data
# (raises bypass it), so this dict provides the short retry cooldown.
_FAILURE_CACHE: dict[tuple, float] = {}
_FAILURE_BACKOFF_S = 300  # 5 min


@st.cache_data(show_spinner=False, ttl=6 * 3600)
def _fetch_one_success_cached(
    yahoo_ticker: str,
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> pd.Series:
    return fetch_one_price_series(yahoo_ticker, start=start, end=end)


def _fetch_one_with_backoff(
    yahoo_ticker: str,
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> pd.Series:
    key = (yahoo_ticker, pd.Timestamp(start).isoformat(), pd.Timestamp(end).isoformat())
    last_fail = _FAILURE_CACHE.get(key)
    if last_fail is not None and (time.time() - last_fail) < _FAILURE_BACKOFF_S:
        remaining = int(_FAILURE_BACKOFF_S - (time.time() - last_fail))
        raise RuntimeError(f"{yahoo_ticker}: backing off after recent failure (retry in {remaining}s)")
    try:
        return _fetch_one_success_cached(yahoo_ticker, start, end)
    except Exception:
        _FAILURE_CACHE[key] = time.time()
        raise


def _fetch_prices_safely(
    tickers: list[str],
    exchange: str,
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> tuple[pd.DataFrame, list[str]]:
    """Per-ticker fetch with caching. Returns (wide-frame keyed by original ticker, list of failed originals)."""
    series_map: dict[str, pd.Series] = {}
    failed: list[str] = []
    for t in tickers:
        ys = yahoo_symbol(t, exchange)
        try:
            series_map[t] = _fetch_one_with_backoff(ys, start, end)
        except Exception:
            failed.append(t)
    if not series_map:
        return pd.DataFrame(), failed
    df = pd.concat(series_map, axis=1).sort_index().dropna(how="all")
    return df, failed


def _clear_price_caches() -> None:
    _FAILURE_CACHE.clear()
    _fetch_one_success_cached.clear()


def _sum_series(parts: list[pd.Series]) -> pd.Series:
    return parts[0] if len(parts) == 1 else pd.concat(parts, axis=1).ffill().fillna(0).sum(axis=1)


def _concat_frames(parts: list[pd.DataFrame]) -> pd.DataFrame:
    return parts[0] if len(parts) == 1 else pd.concat(parts, axis=1).ffill().fillna(0)


_EDITOR_COLS = ["date", "ticker", "action", "quantity", "price", "fees", "exchange", "portfolio"]

st.set_page_config(page_title="Portfolio Returns Viz", layout="wide")
st.title("Portfolio Returns Viz")

# --- Auth gate ---
def _show_auth_page() -> None:
    st.subheader("Sign in to continue")
    mode = st.radio("", ["Login", "Register"], horizontal=True, label_visibility="collapsed")
    email = st.text_input("Email")
    password = st.text_input("Password", type="password")

    if mode == "Login":
        if st.button("Login", type="primary"):
            if not email or not password:
                st.error("Please enter your email and password.")
                return
            try:
                client = get_client()
                resp = client.auth.sign_in_with_password({"email": email, "password": password})
                st.session_state["_auth_session"] = resp.session
                st.session_state["_auth_user"] = resp.user
                st.rerun()
            except Exception as exc:
                st.error(f"Login failed: {exc}")
    else:
        if st.button("Register", type="primary"):
            if not email or not password:
                st.error("Please enter your email and password.")
                return
            try:
                client = get_client()
                resp = client.auth.sign_up({"email": email, "password": password})
                if resp.session:
                    st.session_state["_auth_session"] = resp.session
                    st.session_state["_auth_user"] = resp.user
                    st.rerun()
                else:
                    st.success("Account created! Check your email to confirm your address, then log in.")
            except Exception as exc:
                st.error(f"Registration failed: {exc}")


if st.session_state.get("_auth_session") is None:
    _show_auth_page()
    st.stop()

with st.sidebar:
    user_email = getattr(st.session_state.get("_auth_user"), "email", "")
    st.caption(f"Signed in as {user_email}")
    if st.button("Logout"):
        try:
            get_client().auth.sign_out()
        except Exception:
            pass
        st.session_state.pop("_auth_session", None)
        st.session_state.pop("_auth_user", None)
        st.rerun()
# --- End auth gate ---

uploaded_files = st.file_uploader(
    "Upload brokerage CSV exports (Superhero or Interactive Brokers)",
    type=["csv"],
    accept_multiple_files=True,
)

# Re-parse files and reset editor state only when the set of uploaded files changes.
_files_key = frozenset((uf.name, uf.size) for uf in uploaded_files)
if st.session_state.get("_files_key") != _files_key:
    _all_frames: list[pd.DataFrame] = []
    for uf in uploaded_files:
        raw = uf.read()
        uf.seek(0)
        fmt = _detect_format(raw)
        if fmt == "ib":
            st.caption(f"{uf.name}: detected as Interactive Brokers (USD)")
        elif fmt == "manual":
            st.caption(f"{uf.name}: detected as manual transactions CSV")
        df = load_transactions(uf)
        df["portfolio"] = Path(uf.name).stem
        _all_frames.append(df)
    if _all_frames:
        _parsed = pd.concat(_all_frames, ignore_index=True).sort_values("date").reset_index(drop=True)
        st.session_state["transactions_df"] = _parsed.reindex(columns=_EDITOR_COLS).copy()
    else:
        st.session_state["transactions_df"] = pd.DataFrame(columns=_EDITOR_COLS)
    st.session_state["_files_key"] = _files_key

if not uploaded_files:
    st.info("Upload one or more CSV files to get started. Supported formats: Superhero (AUS/US) and Interactive Brokers.")

_editor_key = f"tx_editor_{abs(hash(_files_key))}"
with st.expander("Transactions", expanded=False):
    st.caption("Edit any row or add new ones — net amount and currency are computed automatically.")
    edited_tx = st.data_editor(
        st.session_state.get("transactions_df", pd.DataFrame(columns=_EDITOR_COLS)),
        num_rows="dynamic",
        column_config={
            "date": st.column_config.DateColumn("Date", required=True),
            "ticker": st.column_config.TextColumn("Ticker", required=True),
            "action": st.column_config.SelectboxColumn("Action", options=["BUY", "SELL"], required=True),
            "quantity": st.column_config.NumberColumn("Quantity", min_value=0, required=True),
            "price": st.column_config.NumberColumn("Price", min_value=0, required=True),
            "fees": st.column_config.NumberColumn("Fees", min_value=0, default=0),
            "exchange": st.column_config.SelectboxColumn("Exchange", options=["ASX", "US"], required=True),
            "portfolio": st.column_config.TextColumn("Portfolio"),
        },
        use_container_width=True,
        key=_editor_key,
    )
    st.session_state["transactions_df"] = edited_tx
    if not edited_tx.dropna(subset=["ticker"]).empty:
        st.download_button(
            "Download transactions CSV",
            edited_tx.to_csv(index=False).encode(),
            "transactions.csv",
            "text/csv",
        )

# Build normalised transactions for the computation pipeline
transactions = edited_tx.dropna(subset=["ticker", "action", "quantity", "price", "exchange"]).copy()
if transactions.empty:
    st.stop()
transactions["date"] = pd.to_datetime(transactions["date"])
transactions["ticker"] = transactions["ticker"].str.strip().str.upper()
transactions["action"] = transactions["action"].str.strip().str.upper()
transactions["quantity"] = pd.to_numeric(transactions["quantity"], errors="coerce").fillna(0).abs()
transactions["fees"] = pd.to_numeric(transactions["fees"], errors="coerce").fillna(0)
transactions["portfolio"] = transactions["portfolio"].fillna("manual").replace("", "manual")
transactions["currency"] = transactions["exchange"].map({"ASX": "AUD", "US": "USD"})
transactions["net_amount"] = transactions.apply(
    lambda r: -(r["quantity"] * r["price"] + r["fees"]) if r["action"] == "BUY"
    else r["quantity"] * r["price"] - r["fees"],
    axis=1,
)
transactions = transactions.sort_values("date").reset_index(drop=True)

# --- Fetch prices and compute value / net-return series per portfolio ---
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

        with st.spinner(f"Fetching {portfolio_name} {currency} prices…"):
            prices, failed_tickers = _fetch_prices_safely(tickers, exchange, start_date, end_date)

        if failed_tickers:
            fetch_failures.extend(f"{portfolio_name} ({currency}): {t}" for t in failed_tickers)
            continue

        if prices.empty:
            fetch_failures.append(f"{portfolio_name} ({currency}): {tickers}")
            continue

        # Forward-fill per-ticker gaps (e.g. exchange-specific holidays where only some tickers lack data).
        # Without this, missing prices produce NaN in symbol_values and silently drop from portfolio_value.sum().
        prices = prices.ffill()

        # Daily cumulative positions (BUY/SELL only)
        trade_rows = trade_rows.copy()
        trade_rows["signed_qty"] = trade_rows.apply(
            lambda r: r["quantity"] if r["action"] == "BUY" else -r["quantity"],
            axis=1,
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

        # Per-symbol and total portfolio value
        symbol_values = positions * prices
        portfolio_value = symbol_values.sum(axis=1)

        # Per-symbol cumulative cashflows → per-symbol net return
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

        # Total net return
        total_cashflows = symbol_cashflows.sum(axis=1)
        net_return = portfolio_value + total_cashflows

        # Per-symbol cumulative dividend income (DIV rows only)
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

        # Convert AUD to USD using historical AUD/USD exchange rates
        if currency == "AUD":
            with st.spinner("Fetching AUD/USD rates…"):
                fx_df, fx_failed = _fetch_prices_safely(["AUDUSD=X"], "US", start_date, end_date)
            if fx_failed or fx_df.empty:
                st.warning(f"{portfolio_name}: Could not fetch AUD/USD rates; displaying in AUD.")
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

    portfolio_groups[portfolio_name] = {
        "portfolio_value": _sum_series(_pv_parts),
        "net_return": _sum_series(_nr_parts),
        "capital_return": _sum_series(_cr_parts),
        "dividend_return": _sum_series(_dr_parts),
        "symbol_values": _concat_frames(_sv_parts),
        "symbol_net_returns": _concat_frames(_snr_parts),
        "symbol_capital_returns": _concat_frames(_scr_parts),
        "symbol_div_cashflows": _concat_frames(_sdc_parts),
        "display_currency": _disp_currency,
        "label": portfolio_name,
    }

if fetch_failures:
    st.error(
        "Could not fetch prices for the following — most likely Yahoo Finance rate-limiting. "
        "Charts are hidden so they don't mislead.\n\n- "
        + "\n- ".join(fetch_failures)
    )
    if st.button("Retry fetching prices", key="retry_prices"):
        _clear_price_caches()
        st.rerun()
    st.stop()

if not portfolio_groups:
    st.error("No portfolio data could be computed. Check that your files contain BUY/SELL rows.")
    st.stop()


def _rolling_ann_return(
    net_return: pd.Series,
    portfolio_value: pd.Series,
    window: int,
) -> pd.Series:
    # Daily cash-flow-adjusted multiplier: net_return.diff() strips out cash injections
    # (net_return = portfolio_value + cumulative_cashflows, so diff cancels the cashflow component).
    # For benchmarks, pass the price series as both arguments — reduces to price[t]/price[t-1].
    daily_mult = (1.0 + net_return.diff() / portfolio_value.shift(1).replace(0, np.nan)).clip(lower=1e-10)
    cumulative_mult = np.exp(np.log(daily_mult).rolling(window, min_periods=window).sum())
    return cumulative_mult ** (252.0 / window) - 1


# --- Chart controls ---
ctrl_left, ctrl_right = st.columns(2)
with ctrl_left:
    view = st.radio("View", ["Total portfolio", "By symbol"], horizontal=True)
with ctrl_right:
    metric = st.radio(
        "Metric",
        ["Portfolio value", "Net return", "Rolling return", "Return breakdown"],
        horizontal=True,
    )

by_symbol = view == "By symbol"
show_rolling = metric == "Rolling return"
show_net_return = metric == "Net return"
show_breakdown = metric == "Return breakdown"

if show_rolling:
    window = st.slider("Rolling window (trading days)", min_value=10, max_value=252, value=60, step=5)

time_range = st.radio(
    "Range",
    ["All", "YTD", "1M", "3M", "6M", "1Y", "3Y", "5Y"],
    horizontal=True,
)
_today = pd.Timestamp.today().normalize()
filter_start: pd.Timestamp | None = {
    "All": None,
    "YTD": pd.Timestamp(_today.year, 1, 1),
    "1M": _today - pd.DateOffset(months=1),
    "3M": _today - pd.DateOffset(months=3),
    "6M": _today - pd.DateOffset(months=6),
    "1Y": _today - pd.DateOffset(years=1),
    "3Y": _today - pd.DateOffset(years=3),
    "5Y": _today - pd.DateOffset(years=5),
}[time_range]


def _trim(s: pd.Series) -> pd.Series:
    return s if filter_start is None else s.loc[s.index >= filter_start]


benchmark_input = st.text_input(
    "Benchmarks",
    placeholder="Yahoo Finance tickers, comma-separated — e.g. ^AXJO, ^GSPC",
)
benchmark_tickers = [t.strip().upper() for t in benchmark_input.split(",") if t.strip()]

# Fetch benchmark prices once, spanning all portfolios
benchmark_prices = pd.DataFrame()
if benchmark_tickers:
    bm_start = min(grp["portfolio_value"].index[0] for grp in portfolio_groups.values())
    bm_end = pd.Timestamp.today().normalize() + pd.Timedelta(days=1)
    with st.spinner("Fetching benchmark prices…"):
        benchmark_prices, bm_failed = _fetch_prices_safely(benchmark_tickers, "US", bm_start, bm_end)
    if bm_failed:
        st.warning(f"Could not fetch benchmark prices for: {', '.join(bm_failed)}")

# --- Chart ---
multi_portfolio = len(portfolio_groups) > 1
fig = go.Figure()

for portfolio_name, grp in portfolio_groups.items():
    disp_currency = grp["display_currency"]
    grp_label = grp["label"]

    if show_rolling:
        if by_symbol:
            items = [
                (
                    f"{grp_label} — {col}" if multi_portfolio else col,
                    grp["symbol_net_returns"][col],
                    grp["symbol_values"][col],
                )
                for col in grp["symbol_values"].columns
            ]
        else:
            items = [(grp_label, grp["net_return"], grp["portfolio_value"])]
        for label, net_ret, pv in items:
            series = _trim(_rolling_ann_return(net_ret, pv, window).dropna())
            fig.add_trace(
                go.Scatter(
                    x=series.index,
                    y=series.values,
                    mode="lines",
                    name=label,
                    hovertemplate=f"{label} %{{x|%Y-%m-%d}}<br>%{{y:.1%}}<extra></extra>",
                ),
            )
    elif show_breakdown:
        if by_symbol:
            for ticker in grp["symbol_capital_returns"].columns:
                for suffix, src in [("cap", grp["symbol_capital_returns"]), ("div", grp["symbol_div_cashflows"])]:
                    series = _trim(src[ticker])
                    if series.abs().max() == 0:
                        continue
                    label = f"{grp_label} — {ticker} ({suffix})" if multi_portfolio else f"{ticker} — {suffix}"
                    fig.add_trace(
                        go.Scatter(
                            x=series.index,
                            y=series.values,
                            mode="lines",
                            name=label,
                            hovertemplate=f"{label} %{{x|%Y-%m-%d}}<br>$%{{y:,.2f}} {disp_currency}<extra></extra>",
                        ),
                    )
        else:
            for label_suffix, key in [("Capital gains", "capital_return"), ("Dividends", "dividend_return")]:
                series = _trim(grp[key])
                if series.abs().max() == 0:
                    continue
                label = f"{grp_label} — {label_suffix}" if multi_portfolio else label_suffix
                fig.add_trace(
                    go.Scatter(
                        x=series.index,
                        y=series.values,
                        mode="lines",
                        name=label,
                        hovertemplate=f"{label} %{{x|%Y-%m-%d}}<br>$%{{y:,.2f}} {disp_currency}<extra></extra>",
                    ),
                )
    elif by_symbol:
        data = grp["symbol_net_returns"] if show_net_return else grp["symbol_values"]
        for ticker in data.columns:
            series = _trim(data[ticker])
            label = f"{grp_label} — {ticker}" if multi_portfolio else ticker
            fig.add_trace(
                go.Scatter(
                    x=series.index,
                    y=series.values,
                    mode="lines",
                    name=label,
                    hovertemplate=f"{label} %{{x|%Y-%m-%d}}<br>$%{{y:,.2f}} {disp_currency}<extra></extra>",
                ),
            )
    else:
        series = _trim(grp["net_return"] if show_net_return else grp["portfolio_value"])
        fig.add_trace(
            go.Scatter(
                x=series.index,
                y=series.values,
                mode="lines",
                name=grp_label,
                hovertemplate=f"%{{x|%Y-%m-%d}}<br>$%{{y:,.2f}} {disp_currency}<extra></extra>",
            ),
        )

# Zero reference line for return-based metrics
if show_rolling or show_net_return or show_breakdown:
    fig.add_hline(y=0, line_dash="dash", line_color="gray", line_width=1)

# Y-axis formatting (use first portfolio's display currency as reference)
first_grp = next(iter(portfolio_groups.values()))
disp_currency = first_grp["display_currency"]
if show_rolling:
    fig.update_yaxes(title_text="Annualised return", tickformat=".0%")
elif show_breakdown or show_net_return:
    fig.update_yaxes(title_text=f"Return ($ {disp_currency})")
else:
    fig.update_yaxes(title_text=f"Value ($ {disp_currency})")

# Overlay benchmarks (not shown in breakdown mode); normalised to first portfolio
if not show_breakdown:
    for bm in benchmark_prices.columns:
        bm_series = benchmark_prices[bm].dropna()
        if bm_series.empty:
            continue
        if show_rolling:
            bm_plot = _trim(_rolling_ann_return(bm_series, bm_series, window).dropna())
            bm_hover = f"{bm} %{{x|%Y-%m-%d}}<br>%{{y:.1%}}<extra></extra>"
        else:
            pv = _trim(first_grp["portfolio_value"])
            non_zero = pv[pv > 0]
            if non_zero.empty:
                continue
            t_ref = non_zero.index[0]
            pv_ref = non_zero.iloc[0]
            bm_after_ref = bm_series[bm_series.index >= t_ref]
            if bm_after_ref.empty:
                continue
            bm_ref = bm_after_ref.iloc[0]
            bm_scaled = bm_series / bm_ref * pv_ref
            bm_plot = _trim((bm_scaled - pv_ref) if show_net_return else bm_scaled)
            bm_hover = f"{bm} %{{x|%Y-%m-%d}}<br>$%{{y:,.2f}} {disp_currency}<extra></extra>"
        fig.add_trace(
            go.Scatter(
                x=bm_plot.index,
                y=bm_plot.values,
                mode="lines",
                name=bm,
                line={"dash": "dash"},
                hovertemplate=bm_hover,
            ),
        )

fig.update_layout(
    height=500,
    showlegend=multi_portfolio or by_symbol or show_rolling or show_breakdown or not benchmark_prices.empty,
    margin={"t": 40, "b": 20},
)
st.plotly_chart(fig, use_container_width=True)
