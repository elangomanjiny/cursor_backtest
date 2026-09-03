"""Exact footprint / order-flow bars from aggTrade ticks."""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from backend.engine.dataloader import IST, ist_bounds

MAX_FOOTPRINT_BARS = 64


def _tick_size(symbol: str) -> float:
    return 0.1 if (symbol or "").upper().startswith("BTC") else 0.01


def _bin_prices(price: pd.Series, tick: float) -> pd.Series:
    """Assign each trade to [bin, bin+tick). Floor — not nearest — matches typical VP/footprint tools."""
    t = float(tick)
    binned = np.floor(price.to_numpy(dtype=float) / t + 1e-9) * t
    return pd.Series(binned, index=price.index)


def _meta(
    *,
    ok: bool,
    reason: str,
    symbol_tick: float,
    bin_mult: int,
    tick: float,
    tf_minutes: int,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "reason": reason,
        "symbol_tick": symbol_tick,
        "bin_mult": bin_mult,
        "tick_size": tick,
        "tf": tf_minutes,
        "bars": extra.pop("bars", []),
        **extra,
    }


def build_footprint_bars(
    ticks: pd.DataFrame | None = None,
    *,
    symbol: str = "ETHUSDT",
    tf_minutes: int = 15,
    tick_size: float | None = None,
    bin_mult: int = 1,
    start: str | None = None,
    end: str | None = None,
    t0_unix: int | None = None,
    t1_unix: int | None = None,
) -> dict[str, Any]:
    """
    Cluster bid/ask volume at each price for bars in [t0, t1).
    Bin size = symbol tick × bin_mult. Caps at MAX_FOOTPRINT_BARS — zoom in if wider.
    """
    from backend.engine.bars import load_ticks as _load_ticks

    tf_minutes = int(tf_minutes)
    symbol_tick = float(tick_size if tick_size is not None else _tick_size(symbol))
    if symbol_tick <= 0:
        symbol_tick = 0.01
    mult = max(1, int(bin_mult or 1))
    tick = symbol_tick * mult

    t0 = t1 = None
    if t0_unix is not None:
        t0 = pd.Timestamp(int(t0_unix), unit="s", tz="UTC")
    if t1_unix is not None:
        t1 = pd.Timestamp(int(t1_unix), unit="s", tz="UTC")
    if t0 is None or t1 is None:
        s0, s1 = ist_bounds(start, end)
        if t0 is None:
            t0 = s0
        if t1 is None:
            t1 = s1
    if t0 is None or t1 is None or t1 <= t0:
        return _meta(
            ok=False,
            reason="bad_range",
            symbol_tick=symbol_tick,
            bin_mult=mult,
            tick=tick,
            tf_minutes=tf_minutes,
        )

    span_bars = int((t1 - t0) / pd.Timedelta(minutes=tf_minutes))
    if span_bars > MAX_FOOTPRINT_BARS:
        return _meta(
            ok=False,
            reason="zoom_in",
            symbol_tick=symbol_tick,
            bin_mult=mult,
            tick=tick,
            tf_minutes=tf_minutes,
            max_bars=MAX_FOOTPRINT_BARS,
            requested_bars=span_bars,
        )

    if ticks is None:
        load_start = t0.tz_convert(IST).strftime("%Y-%m-%d")
        load_end = (t1.tz_convert(IST) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        ticks = _load_ticks(symbol, start=load_start, end=load_end)

    df = ticks.copy()
    if df.empty:
        return _meta(
            ok=True,
            reason="empty",
            symbol_tick=symbol_tick,
            bin_mult=mult,
            tick=tick,
            tf_minutes=tf_minutes,
        )
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df = df[(df["ts"] >= t0) & (df["ts"] < t1)]
    if df.empty:
        return _meta(
            ok=True,
            reason="empty",
            symbol_tick=symbol_tick,
            bin_mult=mult,
            tick=tick,
            tf_minutes=tf_minutes,
        )

    sell = df["aggressor_sell"].astype(bool)
    df["bid_base"] = df["quantity"].where(sell, 0.0)
    df["ask_base"] = df["quantity"].where(~sell, 0.0)
    df["bid_quote"] = (df["quantity"] * df["price"]).where(sell, 0.0)
    df["ask_quote"] = (df["quantity"] * df["price"]).where(~sell, 0.0)
    df["bar"] = df["ts"].dt.floor(f"{tf_minutes}min")
    df["price_r"] = _bin_prices(df["price"], tick)
    ohlc = (
        df.groupby("bar", sort=True)["price"]
        .agg(open="first", high="max", low="min", close="last")
        .dropna()
    )
    lvl = (
        df.groupby(["bar", "price_r"], sort=True)
        .agg(
            bidVolume=("bid_base", "sum"),
            askVolume=("ask_base", "sum"),
            bidQuote=("bid_quote", "sum"),
            askQuote=("ask_quote", "sum"),
            tradeCount=("quantity", "count"),
        )
        .reset_index()
    )
    if ohlc.empty:
        return _meta(
            ok=True,
            reason="empty",
            symbol_tick=symbol_tick,
            bin_mult=mult,
            tick=tick,
            tf_minutes=tf_minutes,
        )

    bars: list[dict[str, Any]] = []
    for ot, row in ohlc.iterrows():
        chunk = lvl[lvl["bar"] == ot]
        levels = [
            {
                "price": float(rec["price_r"]),
                "bidVolume": round(float(rec["bidVolume"]), 6),
                "askVolume": round(float(rec["askVolume"]), 6),
                "bidQuote": round(float(rec["bidQuote"]), 2),
                "askQuote": round(float(rec["askQuote"]), 2),
                "tradeCount": int(rec["tradeCount"]),
            }
            for rec in chunk.to_dict("records")
        ]
        if not levels:
            continue
        tot_bid = sum(x["bidQuote"] for x in levels)
        tot_ask = sum(x["askQuote"] for x in levels)
        poc = max(levels, key=lambda x: x["bidQuote"] + x["askQuote"])
        bars.append(
            {
                "time": int(pd.Timestamp(ot).timestamp()),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "bidQuote": round(tot_bid, 2),
                "askQuote": round(tot_ask, 2),
                "poc": float(poc["price"]),
                "levels": levels,
            }
        )

    return _meta(
        ok=True,
        reason="ok",
        symbol_tick=symbol_tick,
        bin_mult=mult,
        tick=tick,
        tf_minutes=tf_minutes,
        t0=int(t0.timestamp()),
        t1=int(t1.timestamp()),
        count=len(bars),
        bars=bars,
    )
