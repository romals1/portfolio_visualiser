from __future__ import annotations

import io
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, File, UploadFile
from pydantic import BaseModel

from ..services.data import load_transactions
from ..services.prices import fetch_prices_safely, clear_price_caches

router = APIRouter()


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
    cols = ["date", "ticker", "action", "quantity", "price", "fees", "exchange", "portfolio"]
    result = combined.reindex(columns=cols).fillna({"fees": 0.0}).to_dict(orient="records")
    return {"transactions": result}


@router.post("/prices")
async def fetch_prices(request: PriceRequest):
    """
    Fetch prices for multiple tickers with optional FX conversion.
    Returns {prices: {<ticker>: {dates: [], values: []}}, failed: []}

    Note: Returns are keyed by ticker symbol (e.g., "AAPL", "AUDUSD=X") for simplicity.
    For production with cross-exchange symbol collisions, consider keying by f"{exchange}:{ticker}".
    """
    start_dt = pd.to_datetime(request.start).normalize()
    end_dt = pd.to_datetime(request.end).normalize()

    prices_result: dict[str, dict[str, list]] = {}
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

    # Fetch prices per exchange
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

    return {"prices": prices_result, "failed": failed}


@router.post("/portfolio/clear-cache")
async def clear_price_cache():
    clear_price_caches()
    return {"message": "Cache cleared"}
