from __future__ import annotations

import io
import re
from typing import Union

import pandas as pd

_KEEP_TYPES = {"buy": "BUY", "sell": "SELL"}


def _parse_currency(s) -> float:
    if pd.isna(s) or str(s).strip() == "":
        return 0.0
    return float(re.sub(r"[$,]", "", str(s).strip()))


def _detect_format(source) -> str:
    if isinstance(source, (str, bytes, bytearray)):
        first = source[:200].decode("utf-8", errors="replace") if isinstance(source, (bytes, bytearray)) else source[:200]
    else:
        raw = source.read(200)
        source.seek(0)
        first = raw.decode("utf-8", errors="replace") if isinstance(raw, (bytes, bytearray)) else raw
    if first.lstrip().startswith('"Symbol"') or first.lstrip().startswith("Symbol,"):
        return "ib"
    if first.lstrip().lower().startswith("date,"):
        return "manual"
    return "superhero"


def _detect_superhero_exchange(lines: list[str]) -> str:
    """Detect ASX vs US by checking for non-zero Tax (US withholding) in data rows."""
    header_idx = None
    for i, line in enumerate(lines):
        if line.split(",")[0].strip().strip('"') == "Transaction Date":
            header_idx = i
            break
    if header_idx is None:
        return "ASX"
    raw_df = pd.read_csv(io.StringIO("\n".join(lines[header_idx:])))
    raw_df.columns = [c.strip() for c in raw_df.columns]
    if "Tax" in raw_df.columns and (raw_df["Tax"].apply(_parse_currency) > 0).any():
        return "US"
    return "ASX"


def parse_superhero(source: Union[str, io.IOBase], exchange: str | None = None) -> pd.DataFrame:
    """Parse a Superhero brokerage CSV export.

    exchange: "ASX" or "US". When None, auto-detected from the Tax column.
    """
    if hasattr(source, "read"):
        raw = source.read()
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        lines = raw.splitlines()
    else:
        with open(source, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()

    if exchange is None:
        exchange = _detect_superhero_exchange(lines)

    # Find header row: first cell is "Transaction Date"
    header_idx = None
    for i, line in enumerate(lines):
        first_cell = line.split(",")[0].strip().strip('"')
        if first_cell == "Transaction Date":
            header_idx = i
            break
    if header_idx is None:
        raise ValueError("Could not find 'Transaction Date' header row in Superhero CSV")

    data_text = "\n".join(lines[header_idx:])
    df = pd.read_csv(io.StringIO(data_text))
    df.columns = [c.strip() for c in df.columns]

    # Drop the TOTAL summary row
    df = df[df["Transaction Date"].astype(str).str.upper() != "TOTAL"].copy()

    # Normalise transaction type
    df["_type_norm"] = df["Transaction Type"].str.strip().str.lower()
    df = df[df["_type_norm"].isin(_KEEP_TYPES)].copy()
    df["action"] = df["_type_norm"].map(_KEEP_TYPES)

    # Dates
    df["date"] = pd.to_datetime(df["Transaction Date"].str.strip(), format="%d/%m/%Y")

    # Ticker = Security Code column
    df["ticker"] = df["Security Code"].str.strip().str.upper()

    # Numeric fields
    df["quantity"] = df["Quantity"].apply(_parse_currency)
    df["price"] = df["Average Price"].apply(_parse_currency)
    df["net_amount"] = df["Net Amount"].apply(_parse_currency)
    df["fees"] = df["Brokerage"].apply(_parse_currency)

    # DIV rows: zero quantity/price; net_amount already positive from CSV
    mask_div = df["action"] == "DIV"
    df.loc[mask_div, "quantity"] = 0.0
    df.loc[mask_div, "price"] = 0.0

    df["exchange"] = exchange
    df["currency"] = "AUD" if exchange == "ASX" else "USD"

    cols = ["date", "ticker", "action", "quantity", "price", "net_amount", "fees", "exchange", "currency"]
    return df[cols].reset_index(drop=True)


def parse_ib(source: Union[str, io.IOBase]) -> pd.DataFrame:
    """Parse an Interactive Brokers trade confirmation CSV export."""
    df = pd.read_csv(source)
    df.columns = [c.strip() for c in df.columns]

    # Drop FX / non-equity rows (Symbol contains ".")
    df = df[~df["Symbol"].str.contains(r"\.", na=False)].copy()

    df["date"] = pd.to_datetime(df["TradeDate"].astype(str), format="%Y%m%d")
    df["ticker"] = df["Symbol"].str.strip().str.upper()
    df["action"] = df["Buy/Sell"].str.strip().str.upper()

    df["quantity"] = pd.to_numeric(df["Quantity"], errors="coerce").fillna(0.0).abs()
    df["price"] = pd.to_numeric(df["TradePrice"], errors="coerce").fillna(0.0)
    trade_money = pd.to_numeric(df["TradeMoney"], errors="coerce").fillna(0.0)
    commission = pd.to_numeric(df["IBCommission"], errors="coerce").fillna(0.0)
    # net_amount: negative for BUY (money out), positive for SELL (money in)
    df["net_amount"] = -trade_money + commission
    df["fees"] = commission.abs()

    df["exchange"] = "US"
    df["currency"] = "USD"

    cols = ["date", "ticker", "action", "quantity", "price", "net_amount", "fees", "exchange", "currency"]
    return df[cols].reset_index(drop=True)


def parse_manual(source) -> pd.DataFrame:
    """Parse a manually entered / re-uploaded manual transactions CSV."""
    df = pd.read_csv(source)
    df.columns = [c.strip().lower() for c in df.columns]
    df["date"] = pd.to_datetime(df["date"])
    df["ticker"] = df["ticker"].str.strip().str.upper()
    df["action"] = df["action"].str.strip().str.upper()
    df["quantity"] = pd.to_numeric(df["quantity"], errors="coerce").fillna(0).abs()
    df["price"] = pd.to_numeric(df["price"], errors="coerce").fillna(0)
    fees_col = df["fees"] if "fees" in df.columns else pd.Series(0.0, index=df.index)
    df["fees"] = pd.to_numeric(fees_col, errors="coerce").fillna(0)
    df["exchange"] = df["exchange"].str.strip().str.upper()
    df["currency"] = df["exchange"].map({"ASX": "AUD", "US": "USD"}).fillna("USD")
    df["net_amount"] = df.apply(
        lambda r: -(r["quantity"] * r["price"] + r["fees"]) if r["action"] == "BUY"
        else r["quantity"] * r["price"] - r["fees"],
        axis=1,
    )
    cols = ["date", "ticker", "action", "quantity", "price", "net_amount", "fees", "exchange", "currency"]
    return df[cols].dropna(subset=["ticker", "action"]).reset_index(drop=True)


def load_transactions(source, exchange: str | None = None) -> pd.DataFrame:
    """Auto-detect format and parse. exchange is auto-detected for Superhero files."""
    fmt = _detect_format(source)
    if hasattr(source, "seek"):
        source.seek(0)
    if fmt == "ib":
        return parse_ib(source)
    if fmt == "manual":
        return parse_manual(source)
    return parse_superhero(source, exchange)


def convert_aud_to_usd(df: pd.DataFrame) -> pd.DataFrame:
    """Convert price, fees, net_amount from AUD to USD for ASX rows.

    Uses historical AUDUSD=X rates from yfinance. Raises RuntimeError if
    FX data cannot be fetched for the required date range.
    """
    from .prices import fetch_audusd_rates

    mask = df["currency"] == "AUD"
    if not mask.any():
        return df

    aud_dates = df.loc[mask, "date"]
    min_date = aud_dates.min()
    max_date = aud_dates.max()

    fx_series = fetch_audusd_rates(
        start=pd.Timestamp(min_date).normalize(),
        end=pd.Timestamp(max_date).normalize() + pd.Timedelta(days=1),
    )

    if fx_series.empty:
        raise RuntimeError(
            f"Could not fetch AUDUSD=X for date range {min_date.date()}..{max_date.date()}"
        )

    # Build a date-string → rate map with forward fill then back fill
    all_dates = aud_dates.dt.strftime("%Y-%m-%d").unique()
    date_index = pd.DatetimeIndex(sorted(set(fx_series.index.tolist() + [pd.Timestamp(d) for d in all_dates])))
    fx_aligned = fx_series.reindex(date_index).ffill().bfill()
    rate_map = {d.strftime("%Y-%m-%d"): float(v) for d, v in fx_aligned.items() if not pd.isna(v)}

    df = df.copy()
    for col in ["price", "fees", "net_amount"]:
        if col in df.columns:
            df.loc[mask, col] = df.loc[mask].apply(
                lambda r, c=col: r[c] * rate_map.get(r["date"].strftime("%Y-%m-%d"), 1.0),
                axis=1,
            )
    df.loc[mask, "currency"] = "USD"
    return df
