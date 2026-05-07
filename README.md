# Portfolio Returns Viz

A React + FastAPI app that visualises personal stock portfolio returns. Upload brokerage CSV exports, edit transactions, and explore portfolio value, net return, rolling return, and dividend/capital breakdown over time — with benchmark overlays and multi-portfolio support.

## Architecture

```
backend/   FastAPI API (Python)
frontend/  React + TypeScript + Vite UI
```

**Backend pipeline** (`backend/services/`):
- `data.py` — parses Superhero (AUS/US), Interactive Brokers, and manual CSV formats into a normalised DataFrame
- `prices.py` — thin yfinance wrapper; returns tz-naive daily-close Series, raises `RuntimeError` on missing data
- `computation.py` — builds cumulative positions, portfolio value, net/capital/dividend returns, and AUD→USD conversion; thread-safe price cache (6 h TTL, 5 min failure backoff)

**Frontend** (`frontend/src/`):
- `components/Auth.tsx` — Supabase login/register
- `components/FileUpload.tsx` — drag-and-drop multi-file CSV upload
- `components/TransactionTable.tsx` — editable table with add/delete rows and CSV download
- `components/ChartArea.tsx` — view / metric / range / rolling-window / benchmark controls
- `components/PortfolioChart.tsx` — Plotly chart (portfolio value, net return, rolling annualised return, return breakdown)

## Local development

**Backend**

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**Frontend** (separate terminal)

```bash
cd frontend
npm install
npm run dev     # proxies /api → localhost:8000
```

App runs at `http://localhost:5173`.

## Input CSV format

| column   | required | notes                             |
| -------- | -------- | --------------------------------- |
| date     | yes      | YYYY-MM-DD                        |
| ticker   | yes      | e.g. AAPL                         |
| action   | yes      | BUY / SELL / DIV                  |
| quantity | yes      | number of shares                  |
| price    | yes      | per-share price in local currency |
| fees     | no       | defaults to 0                     |
| exchange | yes      | ASX or US                         |

Supported upload formats: **Superhero** (auto-detects ASX vs US), **Interactive Brokers** trade confirmations, **manual** (the format above).

## Deployment (Render)

Two services defined in `render.yaml`:

| Service | Type | Description |
|---|---|---|
| `portfolio-api` | Python web (free) | FastAPI + uvicorn |
| `portfolio-frontend` | Static site | Vite build |

**Environment variables to set:**

`portfolio-api`:
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` — from your Supabase project settings
- `FRONTEND_URL` — URL of the deployed frontend (e.g. `https://portfolio-frontend.onrender.com`) for CORS

`portfolio-frontend`:
- `VITE_API_URL` — URL of the deployed API (e.g. `https://portfolio-api.onrender.com`)

> `VITE_API_URL` is baked in at build time — redeploy the frontend after changing it.

## Linting

```bash
ruff check backend/
```
