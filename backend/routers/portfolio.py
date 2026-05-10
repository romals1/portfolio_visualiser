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
    from ..services.data import convert_aud_to_usd
    try:
        combined = convert_aud_to_usd(combined)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    combined["date"] = combined["date"].dt.strftime("%Y-%m-%d")
    cols = ["date", "ticker", "action", "quantity", "price", "fees", "exchange", "portfolio"]
    result = combined.reindex(columns=cols).fillna({"fees": 0.0}).to_dict(orient="records")
    return {"transactions": result}


@router.post("/prices")
async def fetch_prices(request: PriceRequest):
    """
    Fetch prices and dividends for multiple tickers.
    Returns {prices: {<ticker>: {dates, values}}, dividends: {<ticker>: {dates, values}}, failed: []}

    Prices are raw (unadjusted) close. Dividends are per-share amounts on ex-div
    dates in the ticker's local currency. Dividend fetch failures are silent —
    a ticker that genuinely pays no dividends gets an empty entry.

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

    # Convert ASX (AUD) prices and dividends to USD
    asx_tickers = set(by_exchange.get("ASX", []))
    if asx_tickers:
        from ..services.prices import fetch_audusd_rates
        fx_series = fetch_audusd_rates(start_dt, end_dt)
        if not fx_series.empty:
            fx_map = {d.strftime("%Y-%m-%d"): float(v) for d, v in fx_series.items() if not pd.isna(v)}
            for ticker in asx_tickers:
                if ticker in prices_result:
                    pd_data = prices_result[ticker]
                    prices_result[ticker]["values"] = [
                        v * fx_map.get(d, 1.0)
                        for d, v in zip(pd_data["dates"], pd_data["values"])
                    ]
                if ticker in dividends_result:
                    div_data = dividends_result[ticker]
                    dividends_result[ticker]["values"] = [
                        v * fx_map.get(d, 1.0)
                        for d, v in zip(div_data["dates"], div_data["values"])
                    ]
        else:
            failed.append("AUDUSD=X (FX conversion unavailable)")

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
    """Fetch saved transactions for the authenticated user."""
    from ..services.auth import get_client

    try:
        client = get_client()
        client.postgrest.auth(user.token)
        resp = client.table("user_transactions").select("transactions").eq("user_id", user.user_id).execute()
        if resp.data and len(resp.data) > 0:
            return {"transactions": resp.data[0].get("transactions", [])}
        return {"transactions": []}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch transactions: {str(exc)}")


@router.put("/transactions")
async def save_transactions(body: TransactionsRequest, user: _AuthedUser = Depends(get_authed_user)):
    """Save (upsert) transactions for the authenticated user."""
    from ..services.auth import get_client

    try:
        client = get_client()
        client.postgrest.auth(user.token)
        client.table("user_transactions").upsert(
            {
                "user_id": user.user_id,
                "transactions": body.transactions,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="user_id",
        ).execute()
        return {"message": "Transactions saved", "count": len(body.transactions)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save transactions: {str(exc)}")
