import streamlit as st
import pandas as pd
from pathlib import Path
from portfolio_viz.data import load_transactions
from portfolio_viz.prices import fetch_prices_for_tickers
from portfolio_viz.performance import compute_time_weighted_return, compute_xirr

st.set_page_config(page_title="Portfolio Returns Viz", layout="wide")
st.title("📈 Portfolio Returns Viz")

uploaded = st.file_uploader("Upload transactions CSV", type=["csv"])  # date,ticker,action,quantity,price,fees

if uploaded is not None:
	transactions = load_transactions(uploaded)
else:
	default_path = Path(__file__).resolve().parents[2] / "data" / "sample_transactions.csv"
	if default_path.exists():
		st.info("Using sample transactions from data/sample_transactions.csv")
		transactions = load_transactions(default_path)
	else:
		st.warning("No transactions provided yet. Upload a CSV to get started.")
		st.stop()

st.subheader("Raw Transactions")
st.dataframe(transactions, use_container_width=True)

tickers = sorted(transactions["ticker"].dropna().unique().tolist())
if not tickers:
	st.error("No tickers found in transactions.")
	st.stop()

with st.spinner("Fetching prices..."):
	prices = fetch_prices_for_tickers(tickers)

st.subheader("Prices (sample)")
st.dataframe(prices.tail().reset_index().tail(20), use_container_width=True)

st.subheader("Performance")
col1, col2 = st.columns(2)
with col1:
	twr = compute_time_weighted_return(transactions, prices)
	st.metric("Time-Weighted Return", f"{twr:.2%}")
with col2:
	xirr = compute_xirr(transactions)
	st.metric("XIRR", f"{xirr:.2%}")

st.caption("This is an early prototype. Calculations are approximations and for educational use only.")
