from __future__ import annotations

import io
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, File, UploadFile, Depends, HTTPException, Header
from pydantic import BaseModel

from ..services.data import load_transactions
from ..services.prices import fetch_prices_safely, fetch_dividends_safely, clear_price_caches

router = APIRouter()

_SUPABASE_ENABLED = bool(os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_ANON_KEY"))


class PriceRequest(BaseModel):
    tickers: list[dict[str, str]]  # [{"ticker": "AAPL", "exchange": "US"}, ...]
    start: str  # "YYYY-MM-DD"
    end: str  # "YYYY-MM-DD"


@router.post("/transactions/parse")
async def parse_transactions(files: list[UploadFile] = File(...)):
    all_frames: list[pd.DataFrame] = []
    for file in files:
        raw = await file.read()
        df = load_transactions(io.BytesIO(raw))
        stem = Path(file.filename or "manual").stem
        df["portfolio"] = stem
        all_frames.append(df)

    if not all_frames:
        return {"transactions": []}

    combined = pd.concat(all_frames, ignore_index=True).sort_values("date").reset_index(drop=True)
    combined["date"] = combined["date"].dt.strftime("%Y-%m-%d")
    cols = ["date", "ticker", "action", "quantity", "price", "fees", "exchange", "currency", "portfolio"]
    result = combined.reindex(columns=cols).fillna({"fees": 0.0}).to_dict(orient="records")
    return {"transactions": result}


@router.post("/prices")
async def fetch_prices(request: PriceRequest):
    """
    Fetch prices and dividends for multiple tickers.
    Returns {prices: {<ticker>: {dates, values}}, dividends: {<ticker>: {dates, values}}, failed: []}

    Prices are raw (unadjusted) close in the ticker's local currency (ASX prices
    stay in AUD). Dividends are per-share amounts on ex-div dates in the ticker's
    local currency. Dividend fetch failures are silent — a ticker that genuinely
    pays no dividends gets an empty entry. FX conversion (e.g. AUD→USD) is the
    caller's responsibility — request AUDUSD=X with exchange="US".

    Note: Returns are keyed by ticker symbol (e.g., "AAPL", "AUDUSD=X") for simplicity.
    For production with cross-exchange symbol collisions, consider keying by f"{exchange}:{ticker}".
    """
    start_dt = pd.to_datetime(request.start).normalize()
    end_dt = pd.to_datetime(request.end).normalize()

    prices_result: dict[str, dict[str, list]] = {}
    dividends_result: dict[str, dict[str, list]] = {}
    failed: list[str] = []

    # Group tickers by exchange
    by_exchange: dict[str, list[str]] = {}

    for item in request.tickers:
        ticker = item.get("ticker", "").upper().strip()
        exchange = item.get("exchange", "US").upper().strip()
        if not ticker:
            continue
        if exchange not in by_exchange:
            by_exchange[exchange] = []
        by_exchange[exchange].append(ticker)

    # Fetch prices and dividends per exchange
    for exchange, tickers in by_exchange.items():
        df, failed_for_exchange = fetch_prices_safely(tickers, exchange, start_dt, end_dt)
        failed.extend(f"{t} ({exchange})" for t in failed_for_exchange)

        if not df.empty:
            for col in df.columns:
                # col is the original ticker name (before yahoo_symbol conversion)
                s = df[col].dropna()
                if not s.empty:
                    prices_result[col] = {
                        "dates": s.index.strftime("%Y-%m-%d").tolist(),
                        "values": [float(v) for v in s.values],
                    }

        # Only fetch dividends for tickers whose prices fetched successfully —
        # avoids wasted yfinance calls for invalid symbols. FX symbols never
        # have dividends; this also skips them.
        succeeded = [t for t in tickers if t not in failed_for_exchange]
        div_map = fetch_dividends_safely(succeeded, exchange, start_dt, end_dt)
        for ticker, series in div_map.items():
            s = series.dropna()
            if s.empty:
                dividends_result[ticker] = {"dates": [], "values": []}
                continue
            dividends_result[ticker] = {
                "dates": pd.DatetimeIndex(s.index).strftime("%Y-%m-%d").tolist(),
                "values": [float(v) for v in s.values],
            }

    return {"prices": prices_result, "dividends": dividends_result, "failed": failed}


@router.post("/portfolio/clear-cache")
async def clear_price_cache():
    clear_price_caches()
    return {"message": "Cache cleared"}


@dataclass
class _AuthedUser:
    user_id: str
    token: str


async def get_authed_user(authorization: str | None = Header(None)) -> _AuthedUser:
    """Validate Bearer token, return user_id + raw token for PostgREST RLS forwarding."""
    if not _SUPABASE_ENABLED:
        raise HTTPException(status_code=503, detail="Transactions not configured (missing SUPABASE_URL/ANON_KEY)")

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization[7:]
    from ..services.auth import get_client

    try:
        client = get_client()
        resp = client.auth.get_user(token)
        if not resp or not getattr(resp, "user", None) or not getattr(resp.user, "id", None):
            raise HTTPException(status_code=401, detail="Invalid token: no user")
        return _AuthedUser(user_id=str(resp.user.id), token=token)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token: {str(exc)}")


class TransactionsRequest(BaseModel):
    transactions: list[dict]


@router.get("/transactions")
async def get_transactions(user: _AuthedUser = Depends(get_authed_user)):
    """Fetch saved transactions for the authenticated user, ordered by date asc."""
    from ..services.auth import get_client

    try:
        client = get_client()
        client.postgrest.auth(user.token)
        resp = (
            client.table("user_transaction_rows")
            .select("date,ticker,action,quantity,price,fees,exchange,currency,portfolio")
            .eq("user_id", user.user_id)
            .order("date", desc=False)
            .order("created_at", desc=False)
            .execute()
        )
        rows = resp.data or []
        for r in rows:
            r["quantity"] = float(r["quantity"])
            r["price"] = float(r["price"])
            r["fees"] = float(r["fees"])
        return {"transactions": rows}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch transactions: {str(exc)}")


@router.put("/transactions")
async def save_transactions(body: TransactionsRequest, user: _AuthedUser = Depends(get_authed_user)):
    """Replace all transactions for the authenticated user (delete + insert)."""
    from ..services.auth import get_client

    try:
        client = get_client()
        client.postgrest.auth(user.token)

        # Delete all existing rows for this user (RLS scopes this to the caller)
        client.table("user_transaction_rows").delete().eq("user_id", user.user_id).execute()

        if body.transactions:
            payload = [
                {
                    "user_id": user.user_id,
                    "date": t["date"],
                    "ticker": t["ticker"],
                    "action": t["action"],
                    "quantity": t["quantity"],
                    "price": t["price"],
                    "fees": t.get("fees", 0),
                    "exchange": t["exchange"],
                    "currency": t.get("currency") or ("AUD" if t["exchange"] == "ASX" else "USD"),
                    "portfolio": t["portfolio"],
                }
                for t in body.transactions
            ]
            client.table("user_transaction_rows").insert(payload).execute()

        return {"message": "Transactions saved", "count": len(body.transactions)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save transactions: {str(exc)}")
