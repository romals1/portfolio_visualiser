# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the backend
cd backend && uvicorn main:app --reload --port 8000

# Run the frontend (separate terminal)
cd frontend && npm run dev

# Lint backend
ruff check backend/

# Tests
pytest
```

Set up the backend environment with:

```bash
cd backend && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
```

Set up the frontend with:

```bash
cd frontend && npm install
```

## Architecture

React + TypeScript + Vite frontend (`frontend/`) backed by a FastAPI + uvicorn API (`backend/`). The frontend proxies `/api` to `localhost:8000` in development via Vite config. **All portfolio computation is now client-side in TypeScript.**

### Backend (`backend/`)

Thin API for price fetching and CSV parsing. One-way pipeline: routers call services; services never call routers.

- **`services/data.py`** — `load_transactions()` auto-detects CSV format ("superhero", "ib", "manual") and returns a normalised DataFrame in the trade's native currency (AUD for ASX, USD for US). DIV rows from user CSVs are kept but stripped of quantity/price; dividends from Yahoo Finance are the authoritative source.
- **`services/prices.py`** — `fetch_one_price_series()` fetches adjusted daily close from yfinance. Returns tz-naive Series in the ticker's local currency (ASX prices stay in AUD); raises `RuntimeError` on empty/all-NaN data. `end` param is exclusive; callers pass `last_date + 1 day`. Thread-safe price cache: 6 h TTL on successes, 5 min backoff on failures.
- **`services/auth.py`** — Supabase client factory from `SUPABASE_URL` / `SUPABASE_ANON_KEY` env vars.
- **`routers/auth.py`** — `POST /api/auth/login`, `/register`, `/logout`. Auth is skipped gracefully if Supabase env vars are absent.
- **`routers/portfolio.py`** — `POST /api/transactions/parse` (multipart CSV upload), `POST /api/prices` (fetch prices for multiple tickers), `POST /api/portfolio/clear-cache` (clear price cache).

### Frontend (`frontend/src/`)

- **`App.tsx`** — auth state (localStorage token), transaction state, compute orchestration.
- **`components/Auth.tsx`** — login/register form; calls `/api/auth/login` or `/api/auth/register`.
- **`components/FileUpload.tsx`** — drag-and-drop multi-CSV uploader; calls `POST /api/transactions/parse`.
- **`components/TransactionTable.tsx`** — controlled editable table; add/delete rows, CSV download.
- **`components/ChartArea.tsx`** — chart controls (view, metric, range, rolling window, benchmarks) + Compute button.
- **`components/PortfolioChart.tsx`** — Plotly chart. Rolling annualised return is computed client-side. Benchmark prices are scaled to the first portfolio's initial value.
- **`lib/computation.ts`** — core portfolio computation engine: groups transactions by portfolio/currency, batches price fetch via `/api/prices` (also fetching `AUDUSD=X` for any non-USD currency in the transactions), aligns cashflows to price-bar dates using `alignToAxis()`, applies per-date FX to convert native-currency positions / cashflows / dividends to USD, then aggregates. Returns all symbol-level data in USD.
- **`api/client.ts`** — axios instance; attaches `Authorization: Bearer <token>` from localStorage on every request.

### Data contract

- Transactions DataFrame columns: `date` (tz-naive datetime64), `ticker` / `action` (uppercase str), `quantity` (abs float), `price`, `fees` (default 0.0), `exchange` ("ASX"/"US"), `currency` ("AUD"/"USD"), `net_amount`. `price`, `fees`, and `net_amount` are in the trade's native currency — FX conversion to USD happens client-side at compute time.
- Prices/dividends DataFrames: tz-naive DatetimeIndex, one column per ticker symbol, values in the ticker's local currency.

### Input CSV format

| column   | required | notes                             |
| -------- | -------- | --------------------------------- |
| date     | yes      | YYYY-MM-DD                        |
| ticker   | yes      | e.g. AAPL                         |
| action   | yes      | BUY / SELL / DIV                  |
| quantity | yes      | number of shares                  |
| price    | yes      | per-share price in local currency |
| fees     | no       | defaults to 0                     |
| exchange | yes      | ASX or US                         |

### Agent instructions

Always output with succinct language.
When running commands that may produce large output such as running tests, checks, or builds, always pipe stdout and stderr to a temporary file and only read it if necessary. Always delete the file when done.
For any tasks where you need to retry or do something differently, always add an instruction bullet point below this line to remember next time.
