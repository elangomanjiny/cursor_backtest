"""Build exact FootprintBar payloads from aggTrade ticks (for @stocksharp/chart)."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
PARQUET = ROOT / "data" / "parquet"


def load_ticks(symbol: str = "ETHUSDT") -> pd.DataFrame:
    path = PARQUET / f"{symbol}_ticks.parquet"
    if not path.exists():
        raise FileNotFoundError(f"Missing {path}. Run: python scripts/ingest_aggtrades.py")
    return pd.read_parquet(path)


def build_footprint_bars(
    ticks: pd.DataFrame,
    *,
    tf_minutes: int = 15,
    tick_size: float = 0.01,
    start: str | None = "2026-08-01",
    end: str | None = "2026-08-03",
) -> list[dict[str, Any]]:
    """Return FootprintBar-compatible dicts (Exact order-flow)."""
    df = ticks.copy()
    from backend.engine.dataloader import ist_bounds

    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    t0, t1 = ist_bounds(start, end)
    if t0 is not None:
        df = df[df["ts"] >= t0]
    if t1 is not None:
        df = df[df["ts"] < t1]
    if df.empty:
        return []

    # aggressor: buyer_maker ⇒ sell aggressor (bidVolume); else askVolume
    df["price_r"] = (df["price"] / tick_size).round() * tick_size
    df["bid_vol"] = df["quantity"].where(df["aggressor_sell"], 0.0)
    df["ask_vol"] = df["quantity"].where(~df["aggressor_sell"], 0.0)
    rule = f"{tf_minutes}min"
    indexed = df.set_index("ts")

    ohlc = indexed["price"].resample(rule, label="left", closed="left").agg(["first", "max", "min", "last"])
    ohlc.columns = ["open", "high", "low", "close"]
    ohlc = ohlc.dropna(subset=["open"])

    bars: list[dict[str, Any]] = []
    for ot, row in ohlc.iterrows():
        end_ts = ot + pd.Timedelta(minutes=tf_minutes)
        chunk = indexed.loc[(indexed.index >= ot) & (indexed.index < end_ts)]
        if chunk.empty:
            continue
        lvl = (
            chunk.groupby("price_r", sort=True)
            .agg(bidVolume=("bid_vol", "sum"), askVolume=("ask_vol", "sum"), tradeCount=("quantity", "count"))
            .reset_index()
        )
        levels = [
            {
                "price": float(r.price_r),
                "bidVolume": float(r.bidVolume),
                "askVolume": float(r.askVolume),
                "tradeCount": int(r.tradeCount),
            }
            for r in lvl.itertuples(index=False)
        ]
        bars.append(
            {
                "dataMode": "exact",
                "time": int(ot.timestamp()),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "levels": levels,
            }
        )
    return bars
