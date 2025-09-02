import io
from typing import Union
import pandas as pd

REQUIRED_COLUMNS = ["date", "ticker", "action", "quantity", "price"]


def load_transactions(source: Union[str, io.BytesIO, io.TextIOBase]) -> pd.DataFrame:
	"""Load transactions CSV into a normalized DataFrame.

	Parameters
	----------
	source : path or file-like
		CSV with columns: date,ticker,action,quantity,price,fees(optional)
	"""
	if hasattr(source, "read"):
		df = pd.read_csv(source)
	else:
		df = pd.read_csv(source)

	missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
	if missing:
		raise ValueError(f"Missing required columns: {missing}")

	df = df.copy()
	df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None)
	df["ticker"] = df["ticker"].str.upper().str.strip()
	df["action"] = df["action"].str.upper().str.strip()
	if "fees" not in df.columns:
		df["fees"] = 0.0
	return df
