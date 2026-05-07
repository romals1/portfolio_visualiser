from __future__ import annotations

import io
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from ..services.computation import clear_caches, compute_portfolio
from ..services.data import _detect_format, load_transactions

router = APIRouter()


class TransactionRow(BaseModel):
    date: str
    ticker: str
    action: str
    quantity: float
    price: float
    fees: float = 0.0
    exchange: str
    portfolio: str


class ComputeRequest(BaseModel):
    transactions: list[TransactionRow]
    benchmark_tickers: list[str] = []


@router.post("/transactions/parse")
async def parse_transactions(files: list[UploadFile] = File(...)):
    all_frames: list[pd.DataFrame] = []
    for file in files:
        raw = await file.read()
        fmt = _detect_format(raw)
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


@router.post("/portfolio/compute")
async def compute(request: ComputeRequest):
    if not request.transactions:
        raise HTTPException(status_code=400, detail="No transactions provided")

    df = pd.DataFrame([t.model_dump() for t in request.transactions])
    df = df.dropna(subset=["ticker", "action", "quantity", "price", "exchange"])
    if df.empty:
        raise HTTPException(status_code=400, detail="No valid transactions after filtering")

    df["date"] = pd.to_datetime(df["date"])
    df["ticker"] = df["ticker"].str.strip().str.upper()
    df["action"] = df["action"].str.strip().str.upper()
    df["quantity"] = pd.to_numeric(df["quantity"], errors="coerce").fillna(0).abs()
    df["fees"] = pd.to_numeric(df["fees"], errors="coerce").fillna(0)
    df["portfolio"] = df["portfolio"].fillna("manual").replace("", "manual")
    df["currency"] = df["exchange"].map({"ASX": "AUD", "US": "USD"})
    df["net_amount"] = df.apply(
        lambda r: -(r["quantity"] * r["price"] + r["fees"]) if r["action"] == "BUY"
        else r["quantity"] * r["price"] - r["fees"],
        axis=1,
    )
    df = df.sort_values("date").reset_index(drop=True)

    result = compute_portfolio(df, benchmark_tickers=request.benchmark_tickers)
    return result


@router.post("/portfolio/clear-cache")
async def clear_price_cache():
    clear_caches()
    return {"message": "Cache cleared"}
