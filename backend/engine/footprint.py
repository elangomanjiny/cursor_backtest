"""Exact footprint / order-flow bars from aggTrade ticks."""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from backend.engine.dataloader import IST, ist_bounds, ticks_parts_dir

MAX_FOOTPRINT_BARS = 64
MAX_VAZ_BARS = 512
MAX_FLOW_BARS = 1440
VALUE_AREA_PCT = 0.70

# (symbol, tf, UTC date) → per-bar stats. First hit walks the day; later
# COT/MinΔ pans reuse this without rereading ticks.
_FLOW_DAY_CACHE: dict[tuple[str, int, str], dict[int, dict[str, Any]]] = {}
_FLOW_DAY_CACHE_MAX = 48
# (symbol, UTC date) → that day's tick parquet. Avoids re-reading on pan/zoom.
_TICK_PART_CACHE: dict[tuple[str, str], pd.DataFrame] = {}
_TICK_PART_CACHE_MAX = 6
# (symbol, tf, bin_mult, bar unix) → clustered bar (or None if no trades).
_FP_BAR_CACHE: dict[tuple[str, int, int, int], dict[str, Any] | None] = {}
_FP_BAR_CACHE_MAX = 8192
_FP_MISS = object()


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
    """Cumulative signed volume since the last new high/low of this price path.

    Caller passes one candle's prints. A print resets only on a strict new
    extreme (retests keep adding). First print is always a reset.
    """
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

    COT High / COT Low — per bar, running signed volume since that candle's
    last *new* high / low (retests keep adding). Stored as-of bar close.
    Each candle starts over; the session high/low is not used.
    """
    if ticks is None or ticks.empty:
        return {}
    ts = pd.to_datetime(ticks["ts"], utc=True)
    t0u = pd.Timestamp(t0).tz_convert("UTC")
    t1u = pd.Timestamp(t1).tz_convert("UTC")
    mask = (ts >= t0u) & (ts < t1u)
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

    t0_s = int(t0u.timestamp())
    t1_s = int(t1u.timestamp())
    out: dict[int, dict[str, Any]] = {}

    run_b = _run_from_signed(signed_b, bar_unix)
    run_q = _run_from_signed(signed_q, bar_unix)

    n = int(price.shape[0])
    change = np.empty(n, dtype=bool)
    change[0] = True
    if n > 1:
        change[1:] = bar_unix[1:] != bar_unix[:-1]
    starts = np.flatnonzero(change)
    ends = np.append(starts[1:], n)
    for s, e in zip(starts.tolist(), ends.tolist()):
        bar_t = int(bar_unix[s])
        if bar_t < t0_s or bar_t >= t1_s:
            continue
        pseg = price[s:e]
        sb = signed_b[s:e]
        sq = signed_q[s:e]
        rb = run_b[s:e]
        rq = run_q[s:e]
        cot_h_b = _cot_from_signed(pseg, sb, high=True)
        cot_l_b = _cot_from_signed(pseg, sb, high=False)
        cot_h_q = _cot_from_signed(pseg, sq, high=True)
        cot_l_q = _cot_from_signed(pseg, sq, high=False)
        last = e - s - 1
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
        }
    return out


def cached_day_flow_stats(symbol: str, tf_minutes: int, day_utc: pd.Timestamp) -> dict[int, dict[str, Any]]:
    """Per-bar COT (since this candle's last new high/low) and Min/Max Δ. Cached after first walk."""
    day = _session_start_utc(day_utc)
    key = (str(symbol).upper(), int(tf_minutes), day.strftime("%Y-%m-%d") + ":barcot")
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


def _cached_utc_tick_part(symbol: str, day_utc: pd.Timestamp) -> pd.DataFrame:
    """One UTC calendar day of aggTrades (Binance session). Cached in RAM after first read."""
    day = pd.Timestamp(day_utc).tz_convert("UTC").floor("D")
    key = (str(symbol).upper(), day.strftime("%Y-%m-%d"))
    hit = _TICK_PART_CACHE.get(key)
    if hit is not None:
        return hit
    path = ticks_parts_dir(symbol) / f"part-{key[1]}.parquet"
    cols = ["ts", "price", "quantity", "aggressor_sell"]
    if path.is_file():
        df = pd.read_parquet(path, columns=cols)
    else:
        from backend.engine.bars import load_ticks as _load_ticks

        ist0 = day.tz_convert(IST).strftime("%Y-%m-%d")
        ist1 = (day + pd.Timedelta(days=1)).tz_convert(IST).strftime("%Y-%m-%d")
        df = _load_ticks(symbol, start=ist0, end=ist1)
        keep = [c for c in cols if c in df.columns]
        df = df[keep]
    df = df.copy()
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    if not df.empty:
        ts_np = df["ts"].to_numpy()
        if len(ts_np) > 1 and not bool(np.all(ts_np[1:] >= ts_np[:-1])):
            df = df.sort_values("ts", kind="mergesort")
        df = df.reset_index(drop=True)
    if len(_TICK_PART_CACHE) >= _TICK_PART_CACHE_MAX:
        _TICK_PART_CACHE.pop(next(iter(_TICK_PART_CACHE)))
    _TICK_PART_CACHE[key] = df
    return df


def _slice_sorted_part(part: pd.DataFrame, t0u: pd.Timestamp, t1u: pd.Timestamp) -> pd.DataFrame:
    if part is None or part.empty:
        return pd.DataFrame(columns=["ts", "price", "quantity", "aggressor_sell"])
    i0 = int(part["ts"].searchsorted(t0u, side="left"))
    i1 = int(part["ts"].searchsorted(t1u, side="left"))
    if i0 >= i1:
        return part.iloc[0:0]
    return part.iloc[i0:i1]


def _load_ticks_range(symbol: str, t0: pd.Timestamp, t1: pd.Timestamp) -> pd.DataFrame:
    """Ticks in UTC [t0, t1). Reads each overlapping day part at most once per process."""
    t0u = pd.Timestamp(t0).tz_convert("UTC")
    t1u = pd.Timestamp(t1).tz_convert("UTC")
    frames: list[pd.DataFrame] = []
    for day in _iter_session_days(t0u, t1u):
        part = _cached_utc_tick_part(symbol, day)
        sl = _slice_sorted_part(part, t0u, t1u)
        if sl.empty:
            continue
        frames.append(sl)
    if not frames:
        return pd.DataFrame(columns=["ts", "price", "quantity", "aggressor_sell"])
    return frames[0] if len(frames) == 1 else pd.concat(frames, ignore_index=True)


def _load_ticks_for_window(symbol: str, t0: pd.Timestamp, t1: pd.Timestamp) -> pd.DataFrame:
    """Ticks from the Binance session that contains t0 through t1."""
    return _load_ticks_range(symbol, _session_start_utc(t0), t1)


def _fp_bar_key(symbol: str, tf_minutes: int, bin_mult: int, unix: int) -> tuple[str, int, int, int]:
    return (str(symbol).upper(), int(tf_minutes), int(bin_mult), int(unix))


def _fp_cache_get(key: tuple[str, int, int, int]):
    if key not in _FP_BAR_CACHE:
        return _FP_MISS
    val = _FP_BAR_CACHE.pop(key)
    _FP_BAR_CACHE[key] = val
    return val


def _fp_cache_put(key: tuple[str, int, int, int], val: dict[str, Any] | None) -> None:
    if key in _FP_BAR_CACHE:
        _FP_BAR_CACHE.pop(key)
    elif len(_FP_BAR_CACHE) >= _FP_BAR_CACHE_MAX:
        _FP_BAR_CACHE.pop(next(iter(_FP_BAR_CACHE)))
    _FP_BAR_CACHE[key] = val


def _cluster_ticks(
    ticks: pd.DataFrame,
    *,
    t0: pd.Timestamp,
    t1: pd.Timestamp,
    tick: float,
    tf_minutes: int,
) -> list[dict[str, Any]]:
    """Cluster bid/ask at price for ticks in [t0, t1). Always includes levels."""
    if ticks is None or ticks.empty:
        return []
    keep = [c for c in ("ts", "price", "quantity", "aggressor_sell") if c in ticks.columns]
    df = ticks.loc[:, keep].copy()
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df = df[(df["ts"] >= t0) & (df["ts"] < t1)]
    if df.empty:
        return []

    sell = df["aggressor_sell"].astype(bool)
    qty = df["quantity"]
    px = df["price"]
    df["bid_base"] = qty.where(sell, 0.0)
    df["ask_base"] = qty.where(~sell, 0.0)
    df["bid_quote"] = (qty * px).where(sell, 0.0)
    df["ask_quote"] = (qty * px).where(~sell, 0.0)
    df["bar"] = df["ts"].dt.floor(f"{tf_minutes}min")
    df["price_r"] = _bin_prices(px, tick)
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
        return []

    bars: list[dict[str, Any]] = []
    for ot, chunk in lvl.groupby("bar", sort=True):
        if ot not in ohlc.index:
            continue
        row = ohlc.loc[ot]
        levels = [
            {
                "price": float(rec.price_r),
                "bidVolume": round(float(rec.bidVolume), 6),
                "askVolume": round(float(rec.askVolume), 6),
                "bidQuote": round(float(rec.bidQuote), 2),
                "askQuote": round(float(rec.askQuote), 2),
                "tradeCount": int(rec.tradeCount),
            }
            for rec in chunk.itertuples(index=False)
        ]
        if not levels:
            continue
        tot_bid = sum(x["bidQuote"] for x in levels)
        tot_ask = sum(x["askQuote"] for x in levels)
        poc_q, val_q, vah_q = value_area_from_levels(levels, quote=True)
        poc_b, val_b, vah_b = value_area_from_levels(levels, quote=False)
        bars.append(
            {
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
                "levels": levels,
            }
        )
    return bars


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

    if ticks is not None:
        bars = _cluster_ticks(ticks, t0=t0, t1=t1, tick=tick, tf_minutes=tf_minutes)
        if not include_levels:
            bars = [{**b, "levels": []} for b in bars]
        return _meta(
            ok=True,
            reason="ok" if bars else "empty",
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

    tf_delta = pd.Timedelta(minutes=tf_minutes)
    cur = pd.Timestamp(t0).tz_convert("UTC").floor(f"{tf_minutes}min")
    want: list[int] = []
    while cur < t1:
        want.append(int(cur.timestamp()))
        cur = cur + tf_delta

    miss: list[int] = []
    for unix in want:
        if _fp_cache_get(_fp_bar_key(symbol, tf_minutes, mult, unix)) is _FP_MISS:
            miss.append(unix)

    if miss:
        mt0 = pd.Timestamp(min(miss), unit="s", tz="UTC")
        mt1 = pd.Timestamp(max(miss), unit="s", tz="UTC") + tf_delta
        raw = _load_ticks_range(symbol, mt0, mt1)
        computed = _cluster_ticks(raw, t0=mt0, t1=mt1, tick=tick, tf_minutes=tf_minutes)
        seen = {int(rec["time"]) for rec in computed}
        for rec in computed:
            _fp_cache_put(_fp_bar_key(symbol, tf_minutes, mult, int(rec["time"])), rec)
        for unix in miss:
            if unix not in seen:
                _fp_cache_put(_fp_bar_key(symbol, tf_minutes, mult, unix), None)

    bars: list[dict[str, Any]] = []
    for unix in want:
        rec = _fp_cache_get(_fp_bar_key(symbol, tf_minutes, mult, unix))
        if rec is _FP_MISS or rec is None:
            continue
        if include_levels:
            bars.append(rec)
        else:
            slim = dict(rec)
            slim["levels"] = []
            bars.append(slim)

    return _meta(
        ok=True,
        reason="ok" if bars else "empty",
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


def build_anchored_profile(
    *,
    symbol: str = "ETHUSDT",
    tf_minutes: int = 15,
    t0_unix: int,
    t1_unix: int,
    bin_mult: int = 1,
) -> dict[str, Any]:
    """One composite volume profile for [t0, t1). No per-bar cap — ticks are aggregated by price only."""
    tf_minutes = int(tf_minutes)
    symbol_tick = _tick_size(symbol)
    mult = max(1, int(bin_mult or 1))
    tick = symbol_tick * mult
    t0 = pd.Timestamp(int(t0_unix), unit="s", tz="UTC")
    t1 = pd.Timestamp(int(t1_unix), unit="s", tz="UTC")
    if t1 <= t0:
        return {
            "ok": False,
            "reason": "bad_range",
            "tick_size": tick,
            "levels": [],
        }
    ticks = _load_ticks_range(symbol, t0, t1)
    if ticks is None or ticks.empty:
        return {
            "ok": True,
            "reason": "empty",
            "tick_size": tick,
            "bin_mult": mult,
            "symbol_tick": symbol_tick,
            "tf": tf_minutes,
            "t0": int(t0.timestamp()),
            "t1": int(t1.timestamp()),
            "levels": [],
        }
    keep = [c for c in ("ts", "price", "quantity", "aggressor_sell") if c in ticks.columns]
    df = ticks.loc[:, keep].copy()
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df = df[(df["ts"] >= t0) & (df["ts"] < t1)]
    if df.empty:
        return {
            "ok": True,
            "reason": "empty",
            "tick_size": tick,
            "bin_mult": mult,
            "symbol_tick": symbol_tick,
            "tf": tf_minutes,
            "t0": int(t0.timestamp()),
            "t1": int(t1.timestamp()),
            "levels": [],
        }
    sell = df["aggressor_sell"].astype(bool)
    qty = df["quantity"]
    px = df["price"]
    df["bid_base"] = qty.where(sell, 0.0)
    df["ask_base"] = qty.where(~sell, 0.0)
    df["bid_quote"] = (qty * px).where(sell, 0.0)
    df["ask_quote"] = (qty * px).where(~sell, 0.0)
    df["price_r"] = _bin_prices(px, tick)
    grp = (
        df.groupby("price_r", sort=True)
        .agg(
            bidVolume=("bid_base", "sum"),
            askVolume=("ask_base", "sum"),
            bidQuote=("bid_quote", "sum"),
            askQuote=("ask_quote", "sum"),
            tradeCount=("quantity", "count"),
        )
        .reset_index()
    )
    levels = [
        {
            "price": float(rec.price_r),
            "bidVolume": round(float(rec.bidVolume), 6),
            "askVolume": round(float(rec.askVolume), 6),
            "bidQuote": round(float(rec.bidQuote), 2),
            "askQuote": round(float(rec.askQuote), 2),
            "tradeCount": int(rec.tradeCount),
        }
        for rec in grp.itertuples(index=False)
    ]
    poc_q, val_q, vah_q = value_area_from_levels(levels, quote=True)
    poc_b, val_b, vah_b = value_area_from_levels(levels, quote=False)
    return {
        "ok": True,
        "reason": "ok" if levels else "empty",
        "tick_size": tick,
        "bin_mult": mult,
        "symbol_tick": symbol_tick,
        "tf": tf_minutes,
        "t0": int(t0.timestamp()),
        "t1": int(t1.timestamp()),
        "count": len(levels),
        "va_pct": VALUE_AREA_PCT,
        "poc": poc_q,
        "val": val_q,
        "vah": vah_q,
        "pocBase": poc_b,
        "valBase": val_b,
        "vahBase": vah_b,
        "levels": levels,
    }


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
