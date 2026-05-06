# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the app
streamlit run src/portfolio_viz/app.py

# Lint
ruff check .

# Tests
pytest
```

Set up the environment with:

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
```

## Architecture

This is a Streamlit app (`src/portfolio_viz/`) with three modules that form a one-way pipeline:

1. **`data.py`** — `load_transactions()` parses a user CSV into a normalized DataFrame. DIV rows are stripped at load time; dividends are always sourced from Yahoo Finance instead.

2. **`prices.py`** — `fetch_prices_for_tickers()` is a thin yfinance wrapper. Returns a tz-naive, daily-normalized wide DataFrame (columns = ticker symbols). The yfinance `end` parameter is exclusive, so callers pass `last_transaction_date + 1 day`.

3. **`app.py`** — Streamlit orchestrator. Calls the above in order, builds a daily cumulative positions matrix (`cumsum` of signed quantities) dotted with the aligned prices DataFrame to derive portfolio value. All performance computation is done inline: net return, capital return, dividend return, and rolling annualised return (`_rolling_ann_return`). Supports multiple portfolios, per-symbol views, benchmark overlays, and AUD→USD FX conversion.

### Data contract between modules

- `transactions` DataFrame: `date` column is tz-naive `datetime64`, `ticker` and `action` are uppercase strings, `fees` defaults to `0.0`.
- `prices` / `dividends` DataFrames: tz-naive DatetimeIndex, one column per ticker symbol.

### Input CSV format

| column   | required | notes                             |
| -------- | -------- | --------------------------------- |
| date     | yes      | YYYY-MM-DD                        |
| ticker   | yes      | e.g. AAPL                         |
| action   | yes      | BUY / SELL / DIV                  |
| quantity | yes      | number of shares                  |
| price    | yes      | per-share price in local currency |
| fees     | no       | defaults to 0                     |

Sample file: `data/sample_transactions.csv`. Real transaction exports are in `data/aus_transactions.csv` and `data/us_transactions.csv`.

### Agent instructions

Always output with succint language
When running commands that may produce large output such as running tests, checks, images, always pipe the output and error to a temporary file and only look at it if necessary. Always delete the file if unecessary.
For any tasks where you need to retry or do something differently, always add an instruction bullet point below this line to remember next time.
