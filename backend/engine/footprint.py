"""Exact footprint / order-flow bars from aggTrade ticks."""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from backend.engine.dataloader import IST, ist_bounds

MAX_FOOTPRINT_BARS = 64
MAX_VAZ_BARS = 512
MAX_FLOW_BARS = 512
VALUE_AREA_PCT = 0.70

# (symbol, tf, UTC date) → per-bar stats for that Binance session. First hit
# walks the day; later COT/MinΔ pans reuse this without rereading ticks.
_FLOW_DAY_CACHE: dict[tuple[str, int, str], dict[int, dict[str, Any]]] = {}
_FLOW_DAY_CACHE_MAX = 48


def _session_start_utc(ts: pd.Timestamp) -> pd.Timestamp:
    """Binance UM session = 00:00 UTC (05:30 IST), same as VWAP."""
    return pd.Timestamp(ts).tz_convert("UTC").floor("D")


def _iter_session_days(t0: pd.Timestamp, t1: pd.Timestamp) -> list[pd.Timestamp]:
    day = _session_start_utc(t0)
    end = pd.Timestamp(t1).tz_convert("UTC")
    days: list[pd.Timestamp] = []
    while day < end:
        days.append(day)
        day = day + pd.Timedelta(days=1)
    return days


def _cot_from_signed(price: np.ndarray, signed: np.ndarray, *, high: bool) -> np.ndarray:
    """Cumulative signed volume since the last new session extreme."""
    n = int(price.shape[0])
    if n == 0:
        return signed
    prev = np.empty(n, dtype=np.float64)
    if high:
        prev[0] = -np.inf
        if n > 1:
            prev[1:] = np.maximum.accumulate(price)[:-1]
        fresh = price > prev
    else:
        prev[0] = np.inf
        if n > 1:
            prev[1:] = np.minimum.accumulate(price)[:-1]
        fresh = price < prev
    idx = np.arange(n, dtype=np.int64)
    last = np.maximum.accumulate(np.where(fresh, idx, np.int64(-1)))
    cs = np.cumsum(signed)
    base = np.zeros(n, dtype=np.float64)
    mask = last > 0
    base[mask] = cs[last[mask] - 1]
    return cs - base


def _run_from_signed(signed: np.ndarray, bar_unix: np.ndarray) -> np.ndarray:
    """Intrabar running delta starting at 0 on each new bar."""
    n = int(signed.shape[0])
    if n == 0:
        return signed
    change = np.empty(n, dtype=bool)
    change[0] = True
    if n > 1:
        change[1:] = bar_unix[1:] != bar_unix[:-1]
    idx = np.arange(n, dtype=np.int64)
    first = np.maximum.accumulate(np.where(change, idx, np.int64(-1)))
    cs = np.cumsum(signed)
    base = np.zeros(n, dtype=np.float64)
    mask = first > 0
    base[mask] = cs[first[mask] - 1]
    return cs - base


def walk_orderflow_stats(
    ticks: pd.DataFrame,
    *,
    tf_minutes: int,
    t0: pd.Timestamp,
    t1: pd.Timestamp,
) -> dict[int, dict[str, Any]]:
    """
    Replay prints in time order (vectorized).

    Min/Max Delta — per bar, running signed volume from 0 at the open
    (delta-candle high/low). Close of that path is the bar net delta.

    COT High / COT Low — session cumulative delta since the last *new*
    session high / low (retests keep accumulating). Session resets at
    00:00 UTC. Values stored are as-of each bar's close.
    """
    if ticks is None or ticks.empty:
        return {}
    ts = pd.to_datetime(ticks["ts"], utc=True)
    sess0 = _session_start_utc(t0)
    t0u = pd.Timestamp(t0).tz_convert("UTC")
    t1u = pd.Timestamp(t1).tz_convert("UTC")
    mask = (ts >= sess0) & (ts < t1u)
    if not bool(mask.to_numpy().any()):
        return {}
    if not bool(mask.to_numpy().all()):
        take = mask.to_numpy()
        ts = ts[mask]
        price = ticks["price"].to_numpy(dtype=np.float64, copy=False)[take]
        qty = ticks["quantity"].to_numpy(dtype=np.float64, copy=False)[take]
        sell = ticks["aggressor_sell"].to_numpy(dtype=bool, copy=False)[take]
    else:
        price = ticks["price"].to_numpy(dtype=np.float64, copy=False)
        qty = ticks["quantity"].to_numpy(dtype=np.float64, copy=False)
        sell = ticks["aggressor_sell"].to_numpy(dtype=bool, copy=False)

    ts_vals = ts.to_numpy()
    if len(ts_vals) > 1 and not bool(np.all(ts_vals[1:] >= ts_vals[:-1])):
        order = np.argsort(ts_vals, kind="mergesort")
        price = np.ascontiguousarray(price[order])
        qty = np.ascontiguousarray(qty[order])
        sell = np.ascontiguousarray(sell[order])
        ts = ts.iloc[order]

    signed_b = np.where(sell, -qty, qty).astype(np.float64, copy=False)
    signed_q = signed_b * price
    ts_idx = pd.DatetimeIndex(ts).tz_convert("UTC")
    bar_unix = ts_idx.floor(f"{int(tf_minutes)}min").as_unit("s").asi8
    sess_unix = ts_idx.floor("D").as_unit("s").asi8

    t0_s = int(t0u.timestamp())
    t1_s = int(t1u.timestamp())
    out: dict[int, dict[str, Any]] = {}

    n = int(price.shape[0])
    sess_change = np.empty(n, dtype=bool)
    sess_change[0] = True
    if n > 1:
        sess_change[1:] = sess_unix[1:] != sess_unix[:-1]
    sess_starts = np.flatnonzero(sess_change)
    sess_ends = np.append(sess_starts[1:], n)

    for a, b in zip(sess_starts.tolist(), sess_ends.tolist()):
        px = price[a:b]
        sb = signed_b[a:b]
        sq = signed_q[a:b]
        bu = bar_unix[a:b]
        run_b = _run_from_signed(sb, bu)
        run_q = _run_from_signed(sq, bu)
        cot_h_b = _cot_from_signed(px, sb, high=True)
        cot_l_b = _cot_from_signed(px, sb, high=False)
        cot_h_q = _cot_from_signed(px, sq, high=True)
        cot_l_q = _cot_from_signed(px, sq, high=False)
        sess_hi = np.maximum.accumulate(px)
        sess_lo = np.minimum.accumulate(px)

        change = np.empty(b - a, dtype=bool)
        change[0] = True
        if b - a > 1:
            change[1:] = bu[1:] != bu[:-1]
        starts = np.flatnonzero(change)
        ends = np.append(starts[1:], b - a)
        for s, e in zip(starts.tolist(), ends.tolist()):
            bar_t = int(bu[s])
            if bar_t < t0_s or bar_t >= t1_s:
                continue
            last = e - 1
            rb = run_b[s:e]
            rq = run_q[s:e]
            pseg = px[s:e]
            out[bar_t] = {
                "open": float(pseg[0]),
                "high": float(pseg.max()),
                "low": float(pseg.min()),
                "close": float(pseg[-1]),
                "minDelta": round(float(min(0.0, float(rb.min()))), 6),
                "maxDelta": round(float(max(0.0, float(rb.max()))), 6),
                "minDeltaQuote": round(float(min(0.0, float(rq.min()))), 2),
                "maxDeltaQuote": round(float(max(0.0, float(rq.max()))), 2),
                "cotHigh": round(float(cot_h_b[last]), 6),
                "cotLow": round(float(cot_l_b[last]), 6),
                "cotHighQuote": round(float(cot_h_q[last]), 2),
                "cotLowQuote": round(float(cot_l_q[last]), 2),
                "sessionHigh": float(sess_hi[last]),
                "sessionLow": float(sess_lo[last]),
            }
    return out


def cached_day_flow_stats(symbol: str, tf_minutes: int, day_utc: pd.Timestamp) -> dict[int, dict[str, Any]]:
    """Per-bar COT / MinΔ for one Binance UTC session. Cached after the first walk."""
    day = _session_start_utc(day_utc)
    key = (str(symbol).upper(), int(tf_minutes), day.strftime("%Y-%m-%d"))
    hit = _FLOW_DAY_CACHE.get(key)
    if hit is not None:
        return hit
    nxt = day + pd.Timedelta(days=1)
    ticks = _load_ticks_for_window(symbol, day, nxt)
    stats = walk_orderflow_stats(ticks, tf_minutes=int(tf_minutes), t0=day, t1=nxt)
    if len(_FLOW_DAY_CACHE) >= _FLOW_DAY_CACHE_MAX:
        _FLOW_DAY_CACHE.pop(next(iter(_FLOW_DAY_CACHE)))
    _FLOW_DAY_CACHE[key] = stats
    return stats


def collect_flow_stats(
    symbol: str,
    tf_minutes: int,
    t0: pd.Timestamp,
    t1: pd.Timestamp,
    ticks: pd.DataFrame | None = None,
) -> dict[int, dict[str, Any]]:
    if ticks is not None:
        return walk_orderflow_stats(ticks, tf_minutes=tf_minutes, t0=t0, t1=t1)
    t0_s = int(pd.Timestamp(t0).tz_convert("UTC").timestamp())
    t1_s = int(pd.Timestamp(t1).tz_convert("UTC").timestamp())
    merged: dict[int, dict[str, Any]] = {}
    for day in _iter_session_days(t0, t1):
        merged.update(cached_day_flow_stats(symbol, tf_minutes, day))
    return {k: v for k, v in merged.items() if t0_s <= k < t1_s}


def _load_ticks_for_window(symbol: str, t0: pd.Timestamp, t1: pd.Timestamp) -> pd.DataFrame:
    """Ticks from the Binance session that contains t0 through t1."""
    from backend.engine.bars import load_ticks as _load_ticks

    sess0 = _session_start_utc(t0)
    load_start = sess0.tz_convert(IST).strftime("%Y-%m-%d")
    load_end = (pd.Timestamp(t1).tz_convert(IST) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    return _load_ticks(symbol, start=load_start, end=load_end)


def _tick_size(symbol: str) -> float:
    return 0.1 if (symbol or "").upper().startswith("BTC") else 0.01


def _bin_prices(price: pd.Series, tick: float) -> pd.Series:
    """Assign each trade to [bin, bin+tick). Floor — not nearest — matches typical VP/footprint tools."""
    t = float(tick)
    binned = np.floor(price.to_numpy(dtype=float) / t + 1e-9) * t
    return pd.Series(binned, index=price.index)


def _level_vol(lv: dict[str, Any], *, quote: bool) -> float:
    if quote:
        return float(lv.get("bidQuote") or 0) + float(lv.get("askQuote") or 0)
    return float(lv.get("bidVolume") or 0) + float(lv.get("askVolume") or 0)


def value_area_from_levels(
    levels: list[dict[str, Any]],
    *,
    pct: float = VALUE_AREA_PCT,
    quote: bool = True,
) -> tuple[float | None, float | None, float | None]:
    """
    Classic VP value area: start at POC, expand to the richer adjacent node
    until `pct` of volume is covered. Returns (poc, val, vah) as bin prices.
    """
    if not levels:
        return None, None, None
    rows = sorted(levels, key=lambda x: float(x["price"]))
    vols = [_level_vol(r, quote=quote) for r in rows]
    total = float(sum(vols))
    n = len(rows)
    if total <= 0 or n == 0:
        return None, None, None
    poc_i = max(range(n), key=lambda i: vols[i])
    lo = hi = poc_i
    covered = vols[poc_i]
    target = total * float(pct)
    while covered + 1e-12 < target and (lo > 0 or hi < n - 1):
        below = vols[lo - 1] if lo > 0 else -1.0
        above = vols[hi + 1] if hi < n - 1 else -1.0
        if above > below:
            hi += 1
            covered += vols[hi]
        elif below > above:
            lo -= 1
            covered += vols[lo]
        elif lo > 0 and hi < n - 1:
            lo -= 1
            hi += 1
            covered += vols[lo] + vols[hi]
        elif hi < n - 1:
            hi += 1
            covered += vols[hi]
        else:
            lo -= 1
            covered += vols[lo]
    return float(rows[poc_i]["price"]), float(rows[lo]["price"]), float(rows[hi]["price"])


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
    max_bars: int | None = None,
    include_levels: bool = True,
) -> dict[str, Any]:
    """
    Cluster bid/ask volume at each price for bars in [t0, t1).
    Bin size = symbol tick × bin_mult. Caps at max_bars (default MAX_FOOTPRINT_BARS).
    """
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
    cap = int(max_bars if max_bars is not None else MAX_FOOTPRINT_BARS)
    if span_bars > cap:
        return _meta(
            ok=False,
            reason="zoom_in",
            symbol_tick=symbol_tick,
            bin_mult=mult,
            tick=tick,
            tf_minutes=tf_minutes,
            max_bars=cap,
            requested_bars=span_bars,
        )

    if ticks is None:
        ticks = _load_ticks_for_window(symbol, t0, t1)

    raw = ticks.copy()
    df = raw
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
        poc_q, val_q, vah_q = value_area_from_levels(levels, quote=True)
        poc_b, val_b, vah_b = value_area_from_levels(levels, quote=False)
        rec_bar: dict[str, Any] = {
            "time": int(pd.Timestamp(ot).timestamp()),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "bidQuote": round(tot_bid, 2),
            "askQuote": round(tot_ask, 2),
            "poc": poc_q,
            "val": val_q,
            "vah": vah_q,
            "pocBase": poc_b,
            "valBase": val_b,
            "vahBase": vah_b,
        }
        if include_levels:
            rec_bar["levels"] = levels
        else:
            rec_bar["levels"] = []
        bars.append(rec_bar)

    stats = walk_orderflow_stats(raw, tf_minutes=tf_minutes, t0=t0, t1=t1)
    for rec_bar in bars:
        st = stats.get(int(rec_bar["time"]))
        if not st:
            continue
        for key in (
            "minDelta",
            "maxDelta",
            "minDeltaQuote",
            "maxDeltaQuote",
            "cotHigh",
            "cotLow",
            "cotHighQuote",
            "cotLowQuote",
            "sessionHigh",
            "sessionLow",
        ):
            if key in st:
                rec_bar[key] = st[key]

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
        va_pct=VALUE_AREA_PCT,
        bars=bars,
    )


def build_flow_stats(
    ticks: pd.DataFrame | None = None,
    *,
    symbol: str = "ETHUSDT",
    tf_minutes: int = 15,
    start: str | None = None,
    end: str | None = None,
    t0_unix: int | None = None,
    t1_unix: int | None = None,
    max_bars: int | None = None,
) -> dict[str, Any]:
    """Thin per-bar COT High/Low + Min/Max Delta for the visible range."""
    tf_minutes = int(tf_minutes)
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
        return {"ok": False, "reason": "bad_range", "tf": tf_minutes, "bars": []}

    span_bars = int((t1 - t0) / pd.Timedelta(minutes=tf_minutes))
    cap = int(max_bars if max_bars is not None else MAX_FLOW_BARS)
    if span_bars > cap:
        return {
            "ok": False,
            "reason": "zoom_in",
            "tf": tf_minutes,
            "max_bars": cap,
            "requested_bars": span_bars,
            "bars": [],
        }

    stats = collect_flow_stats(symbol, tf_minutes, t0, t1, ticks=ticks)
    bars = [{"time": unix, **st} for unix, st in sorted(stats.items())]
    if not bars:
        return {"ok": True, "reason": "empty", "tf": tf_minutes, "bars": []}
    return {
        "ok": True,
        "reason": "ok",
        "tf": tf_minutes,
        "t0": int(t0.timestamp()),
        "t1": int(t1.timestamp()),
        "count": len(bars),
        "session": "binance",
        "bars": bars,
    }
