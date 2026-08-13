"""Ingest Binance UM aggTrades ZIP/CSV → parquet bars + tick cache."""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PARQUET = ROOT / "data" / "parquet"


def _read_aggtrades_zip(path: Path) -> pd.DataFrame:
    with zipfile.ZipFile(path) as zf:
        name = [n for n in zf.namelist() if n.endswith(".csv")][0]
        with zf.open(name) as f:
            df = pd.read_csv(f)
    # Binance vision columns (no header in some files — detect)
    if "price" not in df.columns.str.lower():
        df = pd.read_csv(
            zipfile.ZipFile(path).open(name),
            header=None,
            names=[
                "agg_trade_id",
                "price",
                "quantity",
                "first_trade_id",
                "last_trade_id",
                "transact_time",
                "is_buyer_maker",
            ],
        )
    else:
        df.columns = [c.strip().lower() for c in df.columns]
        rename = {
            "agg_trade_id": "agg_trade_id",
            "price": "price",
            "quantity": "quantity",
            "qty": "quantity",
            "transact_time": "transact_time",
            "timestamp": "transact_time",
            "time": "transact_time",
            "is_buyer_maker": "is_buyer_maker",
        }
        df = df.rename(columns={c: rename.get(c, c) for c in df.columns})
    df["price"] = pd.to_numeric(df["price"], errors="coerce")
    df["quantity"] = pd.to_numeric(df["quantity"], errors="coerce")
    df["transact_time"] = pd.to_numeric(df["transact_time"], errors="coerce")
    # bool / string
    if df["is_buyer_maker"].dtype == object:
        df["is_buyer_maker"] = df["is_buyer_maker"].astype(str).str.lower().isin(["true", "1", "t"])
    else:
        df["is_buyer_maker"] = df["is_buyer_maker"].astype(bool)
    df = df.dropna(subset=["price", "quantity", "transact_time"])
    df["ts"] = pd.to_datetime(df["transact_time"], unit="ms", utc=True)
    # aggressor: buyer maker ⇒ seller is aggressor (StockSharp OriginSide.Sell)
    df["aggressor_sell"] = df["is_buyer_maker"]
    df["quote"] = df["price"] * df["quantity"]
    return df[["ts", "price", "quantity", "quote", "aggressor_sell"]].sort_values("ts")


def build_ohlc_and_delta(ticks: pd.DataFrame, tf_minutes: int = 15) -> pd.DataFrame:
    if ticks.empty:
        return pd.DataFrame()
    rule = f"{tf_minutes}min"
    g = ticks.set_index("ts")
    ohlc = g["price"].resample(rule, label="left", closed="left").agg(["first", "max", "min", "last"])
    ohlc.columns = ["open", "high", "low", "close"]
    buy_q = g.loc[~g["aggressor_sell"], "quote"].resample(rule, label="left", closed="left").sum().fillna(0.0)
    sell_q = g.loc[g["aggressor_sell"], "quote"].resample(rule, label="left", closed="left").sum().fillna(0.0)
    buy_b = g.loc[~g["aggressor_sell"], "quantity"].resample(rule, label="left", closed="left").sum().fillna(0.0)
    sell_b = g.loc[g["aggressor_sell"], "quantity"].resample(rule, label="left", closed="left").sum().fillna(0.0)
    out = ohlc.copy()
    out["buy_quote"] = buy_q
    out["sell_quote"] = sell_q
    out["volume_quote"] = out["buy_quote"] + out["sell_quote"]
    out["delta_quote"] = out["buy_quote"] - out["sell_quote"]
    out["buy_base"] = buy_b
    out["sell_base"] = sell_b
    out["volume_base"] = out["buy_base"] + out["sell_base"]
    out["delta_base"] = out["buy_base"] - out["sell_base"]
    out["delta_pct"] = out.apply(
        lambda r: (r["delta_quote"] / r["volume_quote"] * 100.0) if r["volume_quote"] > 0 else 0.0,
        axis=1,
    )
    out = out.dropna(subset=["open", "high", "low", "close"])
    out = out.reset_index().rename(columns={"ts": "open_time"})
    return out


def ingest_symbol(symbol: str = "ETHUSDT", tf_minutes: int = 15) -> Path:
    PARQUET.mkdir(parents=True, exist_ok=True)
    zips = sorted(RAW.glob(f"{symbol}-aggTrades-*.zip"))
    if not zips:
        raise FileNotFoundError(f"No ZIPs in {RAW} matching {symbol}-aggTrades-*.zip")
    frames = [_read_aggtrades_zip(z) for z in zips]
    ticks = pd.concat(frames, ignore_index=True).sort_values("ts")
    bars = build_ohlc_and_delta(ticks, tf_minutes)
    out = PARQUET / f"{symbol}_{tf_minutes}m_bars.parquet"
    bars.to_parquet(out, index=False)
    tick_out = PARQUET / f"{symbol}_ticks.parquet"
    # keep a lighter tick sample optional — full ticks for 2 days is OK
    ticks.to_parquet(tick_out, index=False)
    print(f"Wrote {out} rows={len(bars)}")
    print(f"Wrote {tick_out} rows={len(ticks)}")
    return out


if __name__ == "__main__":
    ingest_symbol("ETHUSDT", 15)
