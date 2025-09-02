# Portfolio Returns Viz

A Streamlit app to visualize returns on personal stock portfolios. Supports cashflow-based performance (TWR/XIRR), ticker price fetching, and interactive charts.

## Quickstart

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
streamlit run src/portfolio_viz/app.py
```

## Data format

Upload a CSV named `transactions.csv` or via the UI with columns:

- date (YYYY-MM-DD)
- ticker (e.g., AAPL)
- action (BUY/SELL/DIV)
- quantity (number)
- price (per share, in your currency)
- fees (optional)

Sample file is in `data/sample_transactions.csv`.

## Features
- Price fetching via Yahoo Finance
- Portfolio valuation over time
- Time-weighted return and XIRR
- Interactive charts

## Dev

```bash
ruff check .
pytest
```

