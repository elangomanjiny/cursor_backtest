"""Volume-delta aggressive-candle strategy — hybrid bar signals + tick exits."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

IST = ZoneInfo("Asia/Kolkata")
ROOT = Path(__file__).resolve().parents[2]
PARQUET = ROOT / "data" / "parquet"
LOGS = ROOT / "logs"

ENGINE_ID = "volume_delta_hybrid"
# Placeholder SL/TP when Risk is off (never plotted / never filled unless Trail/BE arms a real stop)
FAR_LEVEL = 1e12


@dataclass
class Trade:
    side: str
    entry_time: datetime
    exit_time: datetime
    entry_price: float
    exit_price: float
    exit_reason: str
    pnl: float
    stop: float
    target: float
    signal_time: datetime
    signal_high: float
    signal_low: float
    signal_delta_pct: float
    range: float
    mfe: float = 0.0
    mae: float = 0.0
    # Realized costs in quote currency
    slippage: float = 0.0
    fee: float = 0.0
    # LE / SE / LR (long reversed) / SR (short reversed)
    entry_tag: str = "LE"
    # Directional BreakEven: stop was moved to 0.5R lock
    be_moved: bool = False
    # BE target (arm) / lock; from slipped entry. None if BE was off
    be_arm: float | None = None
    be_lock: float | None = None
    # First tick the lock was applied (IST)
    be_moved_time: datetime | None = None
    # Initial stop at entry (before trail / BE)
    stop_init: float = 0.0
    # Compact trail staircase [{time, stop}] when Trail is on
    trail_path: list | None = None


def _excursions(active: dict[str, Any], h: float, l: float) -> None:
    entry = active["entry"]
    if active["is_long"]:
        active["mfe"] = max(float(active.get("mfe", 0.0)), h - entry)
        active["mae"] = max(float(active.get("mae", 0.0)), entry - l)
    else:
        active["mfe"] = max(float(active.get("mfe", 0.0)), entry - l)
        active["mae"] = max(float(active.get("mae", 0.0)), h - entry)


def _apply_slip(px: float, *, is_long: bool, is_entry: bool, slip_pct: float) -> float:
    """Worsen fill by slip_pct (% of price). Long entry + / short entry −; opposite on exit."""
    if slip_pct <= 0:
        return px
    f = slip_pct / 100.0
    if is_entry:
        return px * (1.0 + f) if is_long else px * (1.0 - f)
    return px * (1.0 - f) if is_long else px * (1.0 + f)


def _be_ctc_price_offset(
    entry: float,
    lots: float,
    slip_pct: float,
    fee_pct: float,
    ctc: float,
) -> float:
    """Lock distance in price from the slipped fill.

    Slip and Fee are separate quote costs (not a summed %). Then × CTC / lots.
    """
    lots_n = max(abs(float(lots)), 1e-12)
    notional = abs(float(entry)) * lots_n
    slip_q = notional * (abs(float(slip_pct)) / 100.0)
    fee_q = notional * (abs(float(fee_pct)) / 100.0)
    return (slip_q + fee_q) * max(float(ctc), 0.0) / lots_n


SL_TP_UNITS = frozenset({"range", "tick", "points", "pct"})


def symbol_tick_size(symbol: str) -> float:
    """Binance UM price tick (ETH/BNB/SOL ≈ 0.01; BTC ≈ 0.1)."""
    s = (symbol or "").upper()
    if s.startswith("BTC"):
        return 0.1
    return 0.01


def _normalize_sl_tp_unit(raw: str | None) -> str:
    u = str(raw or "range").strip().lower()
    if u in ("percent", "percentage", "%"):
        return "pct"
    if u in ("point", "pts", "price"):
        return "points"
    if u in ("ticks",):
        return "tick"
    return u if u in SL_TP_UNITS else "range"


def _offset_from_entry(entry: float, value: float, unit: str, tick_size: float) -> float:
    """Absolute price distance for SL/TP magnitude."""
    v = abs(float(value))
    ts = max(float(tick_size), 1e-12)
    if unit == "tick":
        return v * ts
    if unit == "points":
        return v
    if unit == "pct":
        return abs(float(entry)) * (v / 100.0)
    return 0.0


def _unit_offset(
    entry: float,
    value: float,
    unit: str,
    tick_size: float,
    *,
    range_: float = 0.0,
    range_stop: float | None = None,
) -> float:
    """Distance in price for Risk / Trail / BE (Range = AGGR gap or candle range)."""
    u = _normalize_sl_tp_unit(unit)
    ts = max(float(tick_size), 1e-12)
    if u == "range":
        if range_stop is not None:
            d = abs(float(entry) - float(range_stop))
            if d > ts * 0.5:
                return d
        rng = abs(float(range_))
        return rng if rng > ts * 0.5 else ts
    d = _offset_from_entry(entry, value, u, ts)
    return d if d > 0 else ts


def _price_level(
    *,
    raw_entry: float,
    is_long: bool,
    unit: str,
    value: float,
    rr: float,
    range_: float,
    range_stop: float | None,
    tick_size: float,
    is_stop: bool,
) -> float:
    """Stop or target price from an independent unit (Range / tick / points / %)."""
    u = _normalize_sl_tp_unit(unit)
    entry = float(raw_entry)
    if u == "range":
        rng = abs(float(range_))
        if is_stop:
            if range_stop is None:
                raise ValueError("range stop requires range_stop")
            return float(range_stop)
        return entry + rng * float(rr) if is_long else entry - rng * float(rr)
    off = _offset_from_entry(entry, value, u, tick_size)
    ts = max(float(tick_size), 1e-12)
    if off <= 0:
        off = ts
    if is_stop:
        return entry - off if is_long else entry + off
    return entry + off if is_long else entry - off


def resolve_stop_target(
    *,
    raw_entry: float,
    is_long: bool,
    unit: str,
    stop_loss: float,
    take_profit: float,
    rr: float,
    range_: float,
    range_stop: float | None,
    tick_size: float,
) -> tuple[float, float, float]:
    """
    Return (stop, target, trail_offset) in price units.
    unit=range → AGGR/ORB stop + range×RR target (legacy).
    unit=tick|points|pct → fixed distance from entry.
    """
    u = _normalize_sl_tp_unit(unit)
    entry = float(raw_entry)
    if u == "range":
        if range_stop is None:
            raise ValueError("range SL/TP requires range_stop")
        stop = float(range_stop)
        rng = abs(float(range_))
        target = entry + rng * float(rr) if is_long else entry - rng * float(rr)
        trail_off = abs(entry - stop)
        return stop, target, trail_off

    sl_off = _offset_from_entry(entry, stop_loss, u, tick_size)
    tp_off = _offset_from_entry(entry, take_profit, u, tick_size)
    if sl_off <= 0:
        sl_off = float(tick_size)
    if tp_off <= 0:
        tp_off = sl_off * max(float(rr), 0.01)
    if is_long:
        return entry - sl_off, entry + tp_off, sl_off
    return entry + sl_off, entry - tp_off, sl_off


def _make_trade(
    active: dict[str, Any],
    ot: datetime,
    px: float,
    reason: str,
    volume: float,
    *,
    slip_pct: float = 0.0,
    fee_pct: float = 0.0,
) -> Trade:
    is_long = bool(active["is_long"])
    entry = float(active["entry"])  # already slipped at entry
    raw_entry = float(active.get("raw_entry", entry))
    exit_px = _apply_slip(px, is_long=is_long, is_entry=False, slip_pct=slip_pct)
    pnl = (exit_px - entry) * volume if is_long else (entry - exit_px) * volume
    slip_cost = (abs(entry - raw_entry) + abs(exit_px - px)) * volume
    fee = 0.0
    if fee_pct > 0:
        # After slippage, both legs: (entry + exit) × lots × Fee%/100
        # = 2 × avg(entry, exit) × lots × Fee%/100
        fee = (abs(entry) + abs(exit_px)) * volume * (fee_pct / 100.0)
        pnl -= fee
    tag = str(active.get("entry_tag") or ("LE" if is_long else "SE"))
    return Trade(
        side="Long" if is_long else "Short",
        entry_time=_to_ist(active["entry_time"]),
        exit_time=_to_ist(ot),
        entry_price=entry,
        exit_price=exit_px,
        exit_reason=reason,
        pnl=pnl,
        stop=active["stop"],
        target=active["target"],
        signal_time=_to_ist(active["signal_time"]),
        signal_high=active["signal_high"],
        signal_low=active["signal_low"],
        signal_delta_pct=active["signal_delta_pct"],
        range=active["range"],
        mfe=float(active.get("mfe", 0.0)),
        mae=float(active.get("mae", 0.0)),
        slippage=slip_cost,
        fee=fee,
        entry_tag=tag,
        be_moved=bool(active.get("be_moved")),
        be_arm=(
            float(active["be_arm"])
            if active.get("be_enabled") and active.get("be_arm") is not None
            else None
        ),
        be_lock=(
            float(active["be_lock"])
            if active.get("be_enabled") and active.get("be_lock") is not None
            else None
        ),
        be_moved_time=(
            _to_ist(active["be_moved_time"]) if active.get("be_moved_time") is not None else None
        ),
        stop_init=float(active.get("stop_init") or active.get("stop") or 0.0),
        trail_path=_finalize_trail_path(active, ot),
    )


@dataclass
class Aggressive:
    time: datetime
    side: str
    open: float
    high: float
    low: float
    close: float
    volume_usdt: float
    delta_usdt: float
    delta_pct: float
    range: float
    # Pro classifier (Lo/Sh/Se/Co); empty when not Pro or not qualified
    pro_tag: str = ""
    # True when whole candle is above VWAP+Nσ or below VWAP−Nσ (Pro thumb rule)
    vwap_ok: bool = False


@dataclass
class BacktestResult:
    symbol: str
    tf_minutes: int
    wait_and_trade: bool
    rr: float
    volume: float
    threshold: float
    trades: list[Trade]
    aggressive: list[Aggressive]
    bars: list[dict[str, Any]]
    equity: list[dict[str, Any]]
    stats: dict[str, Any]
    re_entry: int = 0
    stop_to_be: int = 0
    break_even: int = 0
    break_even_pct: float = 50.0
    pro_mode: int = 0
    pro_vwap_sigma: float = 2.0
    pro_mtf_mode: int = 0
    base_tf_minutes: int = 0
    base_threshold: float = 0.0
    # Pro-MTF: HTF invalidator timeline for chart overlay (time ISO IST, mode, invalid)
    mtf_bias: list[dict[str, Any]] | None = None


def _as_utc_ts(ts: datetime | pd.Timestamp) -> pd.Timestamp:
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        return t.tz_localize("UTC")
    return t.tz_convert("UTC")


def build_mtf_bias_events(
    base_bars: pd.DataFrame,
    *,
    base_tf_minutes: int,
    base_threshold: float,
) -> list[tuple[pd.Timestamp, str, float]]:
    """
    HTF AGGR → bias timeline.
    Each event (active_from_utc, mode, invalid) becomes active at the *close*
    of the HTF bar (open + base_tf). mode is 'bull' or 'bear'; invalid is
    AGGR low (bull) or high (bear). Bias persists until the next opposite/same
    refresh (latest same-side AGGR refreshes invalid).
    """
    if base_bars is None or base_bars.empty:
        return []
    df = base_bars.copy()
    df["open_time"] = pd.to_datetime(df["open_time"], utc=True)
    df = df.sort_values("open_time")
    thr = abs(float(base_threshold))
    tf_delta = timedelta(minutes=int(base_tf_minutes))
    out: list[tuple[pd.Timestamp, str, float]] = []
    for _, row in df.iterrows():
        dlt = float(row.get("delta_pct", 0.0) or 0.0)
        ot = _as_utc_ts(row["open_time"])
        active_from = ot + tf_delta
        if dlt >= thr:
            out.append((active_from, "bull", float(row["low"])))
        elif dlt <= -thr:
            out.append((active_from, "bear", float(row["high"])))
    return out


def mtf_bias_at(
    events: list[tuple[pd.Timestamp, str, float]],
    ts: datetime | pd.Timestamp,
) -> tuple[str | None, float | None]:
    """Latest HTF bias at/before ts. (None, None) if no HTF AGGR yet."""
    if not events:
        return None, None
    t = _as_utc_ts(ts)
    mode: str | None = None
    inv: float | None = None
    for active_from, m, level in events:
        if active_from <= t:
            mode, inv = m, float(level)
        else:
            break
    return mode, inv


def _mtf_accept_long(low: float, invalid: float | None) -> bool:
    """LTF long: whole candle strictly above the current HTF invalidator."""
    return invalid is not None and float(low) > float(invalid)


def _mtf_accept_short(high: float, invalid: float | None) -> bool:
    """LTF short: whole candle strictly below the current HTF invalidator."""
    return invalid is not None and float(high) < float(invalid)


def _to_ist(ts: pd.Timestamp | datetime) -> datetime:
    if isinstance(ts, pd.Timestamp):
        ts = ts.to_pydatetime()
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(IST)


def _ist_tod_minutes(ts: datetime) -> int:
    ist = _to_ist(ts)
    return ist.hour * 60 + ist.minute


def _in_window(ts: datetime, after_min: int, before_min: int) -> bool:
    tod = _ist_tod_minutes(ts)
    return after_min <= tod < before_min


def _past_session_flat(ts: datetime, exit_time: int) -> bool:
    """True when IST clock has reached Flatten (same test as LTX/STX)."""
    return _ist_tod_minutes(ts) >= int(exit_time)


def _bar_overlaps_flat(ot: datetime, bar_end: datetime, exit_time: int) -> bool:
    """True if any instant in [ot, bar_end) is at/after Flatten."""
    if _past_session_flat(ot, exit_time):
        return True
    last = bar_end - timedelta(microseconds=1)
    if last <= ot:
        return False
    return _past_session_flat(last, exit_time)


def _parse_allowed_hours(raw: str | None) -> set[int] | None:
    """Parse CSV IST hours 0–23, e.g. '8,9,11,15,20'. Empty → None (all hours)."""
    if raw is None or not str(raw).strip():
        return None
    out: set[int] = set()
    for part in str(raw).replace(" ", "").split(","):
        if not part:
            continue
        try:
            h = int(part)
        except ValueError:
            continue
        if 0 <= h <= 23:
            out.add(h)
    return out or None


def _in_session(
    ts: datetime,
    after_min: int,
    before_min: int,
    allowed_hours: set[int] | None,
) -> bool:
    """Entry/AGGR window: After≤clock<Before, and optionally IST hour ∈ allowed set."""
    if not _in_window(ts, after_min, before_min):
        return False
    if allowed_hours is None:
        return True
    return _to_ist(ts).hour in allowed_hours


# Binance UM daily VWAP anchors at 05:30 IST (= 00:00 UTC), not midnight IST.
_BINANCE_VWAP_START_MIN = 5 * 60 + 30


def _binance_session_key(ts: datetime) -> str:
    ist = _to_ist(ts)
    y, m, d = ist.year, ist.month, ist.day
    mins = ist.hour * 60 + ist.minute
    if mins < _BINANCE_VWAP_START_MIN:
        prev = datetime(y, m, d, tzinfo=IST) - timedelta(days=1)
        y, m, d = prev.year, prev.month, prev.day
    return f"{y:04d}-{m:02d}-{d:02d}"


class _BinanceVwapTracker:
    """Running session VWAP + volume-weighted stdev (TradingView-style)."""

    __slots__ = ("sum_v", "sum_pv", "sum_p2v", "sess")

    def __init__(self) -> None:
        self.sum_v = 0.0
        self.sum_pv = 0.0
        self.sum_p2v = 0.0
        self.sess = ""

    def update(self, ot: datetime, typical: float, vol: float) -> tuple[float, float]:
        key = _binance_session_key(ot)
        if key != self.sess:
            self.sum_v = 0.0
            self.sum_pv = 0.0
            self.sum_p2v = 0.0
            self.sess = key
        if vol > 0 and np.isfinite(typical):
            self.sum_v += vol
            self.sum_pv += typical * vol
            self.sum_p2v += typical * typical * vol
        if self.sum_v <= 0:
            return float("nan"), 0.0
        vwap = self.sum_pv / self.sum_v
        var = max(0.0, self.sum_p2v / self.sum_v - vwap * vwap)
        return vwap, float(np.sqrt(var))


def _outside_vwap_nsigma(
    high: float, low: float, vwap: float, stdev: float, n_sigma: float = 2.0
) -> bool:
    """
    Pro thumb rule at selected Nσ: whole candle above +Nσ or whole candle below −Nσ.
    Above: low > VWAP + Nσ. Below: high < VWAP − Nσ. Wick-touch does not qualify.
    """
    n = float(n_sigma)
    if n <= 0 or not (stdev > 0 and np.isfinite(vwap)):
        return False
    upper = vwap + n * stdev
    lower = vwap - n * stdev
    return float(low) > upper or float(high) < lower


def session_tod_bounds(
    entry_after: int,
    entry_before: int,
    exit_time: int,
    *,
    buffer_min: int = 5,
) -> tuple[int, int]:
    """
    IST minute-of-day [lo, hi) for tick loading around the trade window.
    Covers After → max(Before, Flat) plus a small buffer for edge fills.
    """
    buf = max(0, int(buffer_min))
    lo = min(int(entry_after), int(entry_before)) - buf
    hi = max(int(entry_before), int(exit_time)) + buf
    return max(0, lo), min(24 * 60, hi)


def slice_ticks_to_session(
    ticks: pd.DataFrame,
    entry_after: int,
    entry_before: int,
    exit_time: int,
    *,
    buffer_min: int = 5,
) -> pd.DataFrame:
    """
    Keep only ticks whose IST clock falls in the trade window (+ buffer).
    Full-day bars stay elsewhere for indicator precompute; ticks are the costly path.
    """
    if ticks is None or ticks.empty or "ts" not in ticks.columns:
        return ticks
    lo, hi = session_tod_bounds(
        entry_after, entry_before, exit_time, buffer_min=buffer_min
    )
    # Near-full day: slicing buys nothing
    if lo <= 0 and hi >= 24 * 60 - 1:
        return ticks
    ts = pd.to_datetime(ticks["ts"], utc=True)
    ist = ts.dt.tz_convert(IST)
    tod = ist.dt.hour * 60 + ist.dt.minute
    out = ticks.loc[(tod >= lo) & (tod < hi)].copy()
    return out.reset_index(drop=True)


def attach_session_indicators(bars: pd.DataFrame) -> pd.DataFrame:
    """
    Precompute session indicators on *full* bars (idempotent).

    Currently: Binance-session VWAP + volume-weighted σ (ind_vwap, ind_vwap_sd).
    Future strategy indicators should be added here so entry-window ticks can
    look up values without loading overnight ticks.
    """
    if bars is None or bars.empty:
        return bars
    if "ind_vwap" in bars.columns and "ind_vwap_sd" in bars.columns:
        return bars

    df = bars.copy()
    df["open_time"] = pd.to_datetime(df["open_time"], utc=True)
    if not df["open_time"].is_monotonic_increasing:
        df = df.sort_values("open_time").reset_index(drop=True)

    n = len(df)
    ot = df["open_time"]
    h = df["high"].to_numpy(dtype=float, copy=False)
    l = df["low"].to_numpy(dtype=float, copy=False)
    c = df["close"].to_numpy(dtype=float, copy=False)
    if "volume_quote" in df.columns:
        vol_q = df["volume_quote"].to_numpy(dtype=float, copy=False)
    else:
        vol_q = np.zeros(n, dtype=float)
    if "volume_base" in df.columns:
        vol_b = df["volume_base"].to_numpy(dtype=float, copy=False)
    elif "volume" in df.columns:
        vol_b = df["volume"].to_numpy(dtype=float, copy=False)
    else:
        vol_b = np.zeros(n, dtype=float)

    tr = _BinanceVwapTracker()
    vw = np.empty(n, dtype=float)
    sd = np.empty(n, dtype=float)
    for i in range(n):
        typical = (h[i] + l[i] + c[i]) / 3.0
        vol = float(vol_q[i]) if vol_q[i] > 0 else float(vol_b[i])
        ts = ot.iloc[i].to_pydatetime()
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        vw[i], sd[i] = tr.update(ts, typical, vol)

    df["ind_vwap"] = vw
    df["ind_vwap_sd"] = sd
    return df


def _classify_pro_tag(
    delta_pct: float,
    threshold: float,
    high: float,
    low: float,
    ltp: float,
) -> str:
    """
    Lo: +Δ & high≥LTP (Long buy)
    Sh: −Δ & low≤LTP (Short sell)
    Se: +Δ & low≤LTP when not Lo (Long liquidation sell)
    Co: −Δ & high≥LTP when not Sh (Short covering buy)
    """
    thr = abs(float(threshold))
    if thr <= 0 or not np.isfinite(ltp):
        return ""
    d = float(delta_pct)
    if d > thr:
        if high >= ltp:
            return "Lo"
        if low <= ltp:
            return "Se"
        return ""
    if d < -thr:
        if low <= ltp:
            return "Sh"
        if high >= ltp:
            return "Co"
        return ""
    return ""


def _pro_long_bias(tag: str) -> bool:
    return tag in ("Lo", "Co")


def _pro_short_bias(tag: str) -> bool:
    return tag in ("Sh", "Se")


class _TickIndex:
    """Sorted aggTrade stream for post-entry fill tracking."""

    __slots__ = ("ts", "px", "n")

    def __init__(self, ticks: pd.DataFrame):
        if ticks is None or len(ticks) == 0:
            self.ts = np.array([], dtype="datetime64[ns]")
            self.px = np.array([], dtype=np.float64)
            self.n = 0
            return
        df = ticks.sort_values("ts")
        ts = pd.to_datetime(df["ts"], utc=True)
        # numpy datetime64[ns] is naive UTC epoch ns
        self.ts = ts.to_numpy(dtype="datetime64[ns]")
        self.px = df["price"].to_numpy(dtype=np.float64, copy=False)
        self.n = int(len(self.px))

    def seek(self, t: datetime | pd.Timestamp, start: int = 0) -> int:
        """First index with ts >= t."""
        if self.n == 0:
            return 0
        key = np.datetime64(_as_utc_ts(t).to_datetime64())
        i = int(np.searchsorted(self.ts, key, side="left"))
        return max(i, start)

    def first_touch(
        self,
        *,
        t0: datetime | pd.Timestamp,
        t1: datetime | pd.Timestamp,
        level: float,
        is_long: bool,
        start: int = 0,
    ) -> tuple[int, pd.Timestamp] | None:
        """First tick in [t0, t1) that confirms wait-and-trade touch."""
        i = self.seek(t0, start)
        end = self.seek(t1, i)
        if is_long:
            while i < end:
                if self.px[i] >= level:
                    return i, pd.Timestamp(self.ts[i], tz="UTC")
                i += 1
        else:
            while i < end:
                if self.px[i] <= level:
                    return i, pd.Timestamp(self.ts[i], tz="UTC")
                i += 1
        return None

    def first_orb_break(
        self,
        *,
        t0: datetime | pd.Timestamp,
        t1: datetime | pd.Timestamp,
        high: float,
        low: float,
        allow_long: bool,
        allow_short: bool,
        start: int = 0,
    ) -> tuple[int, pd.Timestamp, bool] | None:
        """
        First tick in [t0, t1) that *crosses* ORB high (long) or low (short).

        Strict crossover (not mere touch while already beyond the level):
          long:  prev < high and px >= high
          short: prev > low  and px <= low
        """
        i = self.seek(t0, start)
        end = self.seek(t1, i)
        if i >= end:
            return None
        # Prior tick (may be before t0) establishes which side we came from
        prev: float | None = float(self.px[i - 1]) if i > 0 else None
        while i < end:
            px = float(self.px[i])
            if prev is not None:
                hit_long = allow_long and prev < high and px >= high
                hit_short = allow_short and prev > low and px <= low
                if hit_long or hit_short:
                    # Same tick both sides (degenerate range): prefer long
                    is_long = bool(hit_long)
                    return i, pd.Timestamp(self.ts[i], tz="UTC"), is_long
            prev = px
            i += 1
        return None


def _prepare_ticks(
    symbol: str,
    bars: pd.DataFrame,
    ticks: pd.DataFrame | None,
) -> _TickIndex:
    if ticks is None:
        from backend.engine.bars import load_ticks

        start = end = None
        if not bars.empty:
            t0 = _as_utc_ts(bars["open_time"].iloc[0])
            last = _as_utc_ts(bars["open_time"].iloc[-1])
            start = t0.tz_convert(IST).strftime("%Y-%m-%d")
            # exclusive IST end = day after last bar open (+1 day cushion for last bar ticks)
            end = (last.tz_convert(IST) + timedelta(days=2)).strftime("%Y-%m-%d")
        ticks = load_ticks(symbol, start=start, end=end)
    df = ticks.copy()
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    if not bars.empty:
        t0 = _as_utc_ts(bars["open_time"].iloc[0])
        last = _as_utc_ts(bars["open_time"].iloc[-1])
        # include full last bar + small cushion
        tf_guess = timedelta(minutes=60)
        t1 = last + tf_guess
        df = df[(df["ts"] >= t0) & (df["ts"] < t1)]
    if df.empty:
        raise FileNotFoundError(
            f"No aggTrade ticks available for {symbol} in the backtest range. "
            "Load data (Step 1) so tick parts under data/parquet/{symbol}_ticks/ exist."
        )
    return _TickIndex(df)


def _record_trail(active: dict[str, Any], ts: datetime | pd.Timestamp, stop: float) -> None:
    """Append a trail vertex only when the stop actually tightens."""
    if not active.get("trail_stop"):
        return
    st = float(stop)
    if abs(st) >= FAR_LEVEL / 10.0:
        return
    path: list[tuple[datetime, float]] = active.setdefault("trail_path", [])
    t = _as_utc_ts(ts).to_pydatetime()
    if path:
        last_t, last_p = path[-1]
        if abs(st - last_p) < 1e-9:
            return
        if int(t.timestamp()) == int(_as_utc_ts(last_t).timestamp()):
            path[-1] = (t, st)
            return
    path.append((t, st))


def _finalize_trail_path(
    active: dict[str, Any], exit_ts: datetime
) -> list[dict[str, Any]] | None:
    if not active.get("trail_stop"):
        return None
    _record_trail(active, exit_ts, float(active.get("stop") or 0.0))
    raw: list[tuple[datetime, float]] = list(active.get("trail_path") or [])
    if not raw:
        return None
    if len(raw) == 1:
        raw.append((_as_utc_ts(exit_ts).to_pydatetime(), float(raw[0][1])))
    tf_sec = max(int(active.get("trail_tf_sec") or 60), 1)
    origin = int(_as_utc_ts(active["entry_time"]).timestamp())
    buckets: dict[int, float] = {}
    order: list[int] = []
    for t, p in raw:
        ts = int(_as_utc_ts(t).timestamp())
        b = origin + ((ts - origin) // tf_sec) * tf_sec
        if b not in buckets:
            order.append(b)
        buckets[b] = float(p)
    last_ts = int(_as_utc_ts(exit_ts).timestamp())
    last_p = float(active.get("stop") or 0.0)
    if last_ts not in buckets:
        order.append(last_ts)
    buckets[last_ts] = last_p
    return [
        {
            "time": _to_ist(datetime.fromtimestamp(b, tz=timezone.utc)).isoformat(),
            "stop": round(float(buckets[b]), 4),
        }
        for b in order
    ]


def _scan_ticks_until(
    book: _TickIndex,
    i: int,
    active: dict[str, Any],
    *,
    until: datetime | pd.Timestamp,
    exit_time: int,
    time_stop_minutes: float = 0.0,
) -> tuple[int, datetime | None, float | None, str | None]:
    """
    Walk ticks from i while ts < until.
    Returns (next_i, exit_ts, exit_px, reason). reason None => still open.
    Stop/target fills use level price; session/time-stop/EOD use trade price.
    BreakEven: when arm touched once, move stop to lock (no exit).
    """
    if book.n == 0 or i >= book.n:
        return i, None, None, None

    is_long = bool(active["is_long"])
    entry = float(active["entry"])
    entry_ts = _as_utc_ts(active["entry_time"]).to_pydatetime()
    until_key = np.datetime64(_as_utc_ts(until).to_datetime64())
    tstop = float(time_stop_minutes or 0.0)

    while i < book.n and book.ts[i] < until_key:
        ts = pd.Timestamp(book.ts[i], tz="UTC").to_pydatetime()
        px = float(book.px[i])
        stop = float(active["stop"])
        target = float(active["target"])

        # MFE/MAE from actual trades
        if is_long:
            active["mfe"] = max(float(active.get("mfe", 0.0)), px - entry)
            active["mae"] = max(float(active.get("mae", 0.0)), entry - px)
        else:
            active["mfe"] = max(float(active.get("mfe", 0.0)), entry - px)
            active["mae"] = max(float(active.get("mae", 0.0)), px - entry)

        if _past_session_flat(ts, exit_time):
            return i + 1, ts, px, ("LTX" if is_long else "STX")

        if tstop > 0:
            held_min = (ts - entry_ts).total_seconds() / 60.0
            if held_min >= tstop:
                return i + 1, ts, px, "TTS"

        # Optional trailing stop: ratchet stop by trail_offset as price moves favorably
        if active.get("trail_stop") and float(active.get("trail_offset") or 0) > 0:
            off = float(active["trail_offset"])
            if is_long:
                trailed = px - off
                if trailed > stop:
                    active["stop"] = trailed
                    stop = trailed
                    active["use_stop"] = True
                    _record_trail(active, ts, stop)
            else:
                trailed = px + off
                if trailed < stop:
                    active["stop"] = trailed
                    stop = trailed
                    active["use_stop"] = True
                    _record_trail(active, ts, stop)

        # BreakEven: arm = target from slipped entry; lock = be_frac × that distance (once)
        if active.get("be_enabled") and not active.get("be_moved"):
            arm = float(active["be_arm"])
            lock = float(active["be_lock"])
            armed = (px >= arm) if is_long else (px <= arm)
            if armed:
                active["stop"] = lock
                active["be_moved"] = True
                active["be_moved_time"] = ts
                active["use_stop"] = True
                pe = active.setdefault("pending_events", [])
                pe.append(f"BE@{lock:.2f}")
                stop = lock
                _record_trail(active, ts, stop)

        use_stop = bool(active.get("use_stop"))
        use_target = bool(active.get("use_target"))
        flip_px = active.get("flip_px")

        if is_long:
            if use_stop and px <= stop:
                if active.get("be_moved"):
                    return i + 1, ts, stop, "LB"
                return i + 1, ts, stop, "LSL"
            if use_target and px >= target:
                return i + 1, ts, target, "LT"
            if flip_px is not None and px <= float(flip_px):
                return i + 1, ts, float(flip_px), "LR"
        else:
            if use_stop and px >= stop:
                if active.get("be_moved"):
                    return i + 1, ts, stop, "SB"
                return i + 1, ts, stop, "SSL"
            if use_target and px <= target:
                return i + 1, ts, target, "ST"
            if flip_px is not None and px >= float(flip_px):
                return i + 1, ts, float(flip_px), "SR"
        i += 1

    return i, None, None, None


def run_backtest(
    bars: pd.DataFrame,
    *,
    symbol: str = "ETHUSDT",
    tf_minutes: int = 15,
    wait_and_trade: bool = False,
    rr: float = 1.0,
    volume: float = 0.001,
    threshold: float = 50.0,
    entry_after: int = 330,
    entry_before: int = 1260,
    exit_time: int = 1260,
    trade_mode: int = 2,
    slippage_pct: float = 0.0,
    fee_pct: float = 0.0,
    time_stop_minutes: float = 0.0,
    re_entry: int = 0,
    stop_to_be: int = 0,
    break_even: int = 0,
    break_even_pct: float = 50.0,
    pro_mode: bool = False,
    pro_vwap_sigma: float = 2.0,
    ticks: pd.DataFrame | None = None,
    allowed_entry_hours: str | None = None,
    sl_tp_unit: str = "range",
    stop_loss: float = 50.0,
    take_profit: float = 100.0,
    trail_stop: int = 0,
    risk_on: int | None = 1,
    sl_on: int | None = None,
    tp_on: int | None = None,
    sl_unit: str | None = None,
    tp_unit: str | None = None,
    trail_unit: str = "range",
    trail_value: float = 0.0,
    be_unit: str = "range",
    be_value: float = 0.0,
    be_ctc: float = 2.0,
    pro_mtf_mode: bool = False,
    base_tf_minutes: int = 15,
    base_threshold: float = 30.0,
    base_bars: pd.DataFrame | None = None,
) -> BacktestResult:
    """
    Hybrid engine: bar AGGR/entry levels + tick SL/TP/session fills.

    Session (IST, entry_after…entry_before, default 05:30–21:00):
      Only bars inside this window can form Aggressive candles / arm setups.
      Entries also require the entry bar open to fall inside the window.
      Flatten (exit_time) closes an open trade (LTX/STX) and drops pending ORB /
      next-bar setups / reverse-at-open so the next session cannot fill
      yesterday's range. New AGGRs after After-time still arm.

    Performance:
      Session indicators (VWAP ±σ, …) are precomputed on *full* bars.
      Ticks are sliced to After → max(Before, Flat) (+ TF buffer) so a 2h/4h/6h
      window does not require loading overnight ticks.

    Directional (wait_and_trade=False, pro_mode=False) — Baseline:
      Buy AGGR → long only; Sell AGGR → short only; next-bar open
      SL/TP optional (Risk On/Off). Trail and BreakEven have independent units.
      Opposite AGGR reverses: next-bar open. Tags: LR = long reversed → short.

    Non-Directional (wait_and_trade=True) — ORB first entry + opposite-AGGR reverse:
      Any AGGR → shared range; crossover of high/low for LE/SE.
      Reverse on opposite AGGR high/low fill (not on stop). Stop is a hard LSL/SSL.

    Pro (pro_mode=True; wait_and_trade ignored/forced off):
      Classify AGGR as Lo/Sh/Se/Co vs prior close (LTP).
      Qualifier (thumb rule): whole candle above VWAP+Nσ (low > +Nσ) or whole
      candle below VWAP−Nσ (high < −Nσ). Wick-touch of the band does not qualify.
      Long entries from Lo|Co; Short from Sh|Se; next-bar open (Directional-style).
      Opposite Pro tag reverses at next bar open (Lo|Co vs Sh|Se). Tags LR/SR.
      Optional BreakEven; no ORB trail. Pro-MTF does not reverse.

    Pro-MTF (pro_mtf_mode=True):
      Base TF AGGR sets bull/bear + invalidator (Buy→low, Sell→high) at HTF close.
      Latest HTF AGGR always replaces the line (rule A). No VWAP. No LR/SR reverse.
      LTF trades both sides of the *current* line (whole candle, next-bar open):
        Buy AGGR and low > invalid → long (close short if open).
        Sell AGGR and high < invalid → short (close long if open).
      New HTF AGGR always replaces the line. Same side as the open trade
      (long+bull / short+bear) → keep it; LTF uses the new invalidator.
      Against the open trade → flatten (LMTFX/SMTFX) unless the original
      signal candle is still a legal other-side trade vs the new line.
      Wick through the line does not exit and does not change HTF bias.
    """
    mtf = bool(pro_mtf_mode)
    pro = bool(pro_mode) and not mtf
    if pro or mtf:
        wait_and_trade = False
    if mtf:
        pro = False
    sigma_n = float(pro_vwap_sigma) if float(pro_vwap_sigma or 0) > 0 else 2.0
    if sigma_n not in (1.0, 2.0, 3.0):
        # snap to nearest of 1/2/3
        sigma_n = min((1.0, 2.0, 3.0), key=lambda x: abs(x - sigma_n))
    allow_long = trade_mode in (0, 2)
    allow_short = trade_mode in (1, 2)
    slip = float(slippage_pct or 0.0)
    fee = float(fee_pct or 0.0)
    tstop = float(time_stop_minutes or 0.0)
    # Pro features: forced off for now
    re_en = 0
    stobe = 0
    # Stop is a hard exit. Reverse is opposite-AGGR (Dir, Non-Dir, Pro).
    # Pro-MTF flattens via LMTFX/SMTFX then arms the other side (not LR/SR).
    allow_reverse = False
    sl_u = _normalize_sl_tp_unit(sl_unit or sl_tp_unit)
    tp_u = _normalize_sl_tp_unit(tp_unit or sl_tp_unit)
    tick_sz = symbol_tick_size(symbol)
    trail_on = 1 if int(trail_stop or 0) else 0
    risk_fallback = 1 if int(risk_on if risk_on is not None else 1) else 0
    sl_live = 1 if int(sl_on if sl_on is not None else risk_fallback) else 0
    tp_live = 1 if int(tp_on if tp_on is not None else risk_fallback) else 0
    risk_live = 1 if (sl_live or tp_live) else 0
    trail_u = _normalize_sl_tp_unit(trail_unit)
    trail_val = float(trail_value if trail_value is not None else 0.0)
    be_u = _normalize_sl_tp_unit(be_unit)
    be_val = float(be_value if be_value is not None else 0.0)
    ctc = max(0.0, float(be_ctc if be_ctc is not None else 2.0))
    sl_val = float(stop_loss if stop_loss is not None else 50.0)
    tp_val = float(take_profit if take_profit is not None else 100.0)
    allow_trail = False
    aggr_reverse = not mtf  # Dir + Non-Dir + Pro; Pro-MTF uses LMTFX/SMTFX, not LR/SR
    # BreakEven: arm from be_unit/be_value (when). Lock = CTC × (slip USDT + fee USDT) / lots.
    be_on = 1 if int(break_even or 0) else 0
    if be_u == "range":
        be_frac = 0.5
    elif be_u == "pct":
        be_frac = max(0.01, min(1.0, (be_val if be_val > 0 else 50.0) / 100.0))
    else:
        be_frac = 0.0
    tf_delta = timedelta(minutes=int(tf_minutes))
    hour_set = _parse_allowed_hours(allowed_entry_hours)

    base_tf = int(base_tf_minutes or 15)
    base_thr = float(base_threshold if base_threshold is not None else 30.0)
    mtf_events: list[tuple[pd.Timestamp, str, float]] = []
    if mtf:
        if base_tf <= int(tf_minutes):
            raise ValueError(
                f"Pro-MTF requires Base TF ({base_tf}m) strictly greater than chart TF ({tf_minutes}m)."
            )
        if base_bars is None or getattr(base_bars, "empty", True):
            raise ValueError(
                f"Pro-MTF needs base_bars for {base_tf}m. Load/build that timeframe first."
            )
        mtf_events = build_mtf_bias_events(
            base_bars, base_tf_minutes=base_tf, base_threshold=base_thr
        )

    df = bars.copy()
    df["open_time"] = pd.to_datetime(df["open_time"], utc=True)
    # Full-bar indicator pass (VWAP etc.) — independent of tick window length
    df = attach_session_indicators(df)
    buf = max(5, int(tf_minutes))
    tick_lo, tick_hi = session_tod_bounds(
        entry_after, entry_before, exit_time, buffer_min=buf
    )
    if ticks is None:
        from backend.engine.bars import load_ticks as _load_ticks

        start = end = None
        if not df.empty:
            t0 = _as_utc_ts(df["open_time"].iloc[0])
            last = _as_utc_ts(df["open_time"].iloc[-1])
            start = t0.tz_convert(IST).strftime("%Y-%m-%d")
            end = (last.tz_convert(IST) + timedelta(days=2)).strftime("%Y-%m-%d")
        ticks = _load_ticks(symbol, start=start, end=end)
    ticks = slice_ticks_to_session(
        ticks, entry_after, entry_before, exit_time, buffer_min=buf
    )
    if ticks is None or ticks.empty:
        raise FileNotFoundError(
            f"No aggTrade ticks in session window "
            f"{tick_lo//60:02d}:{tick_lo%60:02d}–{tick_hi//60:02d}:{tick_hi%60:02d} IST "
            f"for {symbol}. Widen After/Flat or load more data."
        )
    book = _prepare_ticks(symbol, df, ticks)
    tick_i = 0

    long_setup = None  # Wait=false directional / pro
    short_setup = None
    orb: dict[str, Any] | None = None  # Wait=true shared ORB range
    pending_reentry: dict[str, Any] | None = None
    aggr_flip: dict[str, Any] | None = None  # Directional: reverse at next bar open
    mtf_flip: dict[str, Any] | None = None  # Pro-MTF: flatten + other side at next open
    last_mtf_mode: str | None = None
    active = None
    trades: list[Trade] = []
    aggressive: list[Aggressive] = []
    equity_curve: list[dict[str, Any]] = []
    realized = 0.0
    bar_rows: list[dict[str, Any]] = []
    last_eq_ts: pd.Timestamp | None = None
    prev_close: float | None = None
    has_ind_vwap = "ind_vwap" in df.columns and "ind_vwap_sd" in df.columns
    # Fallback tracker only if indicators were not attached
    vwap_tr = None if has_ind_vwap else _BinanceVwapTracker()

    def _push_equity(ts: datetime | pd.Timestamp) -> None:
        """Append equity only in non-decreasing time order (required by chart)."""
        nonlocal last_eq_ts
        t = _as_utc_ts(ts)
        if last_eq_ts is not None and t < last_eq_ts:
            return
        if last_eq_ts is not None and t == last_eq_ts and equity_curve:
            equity_curve[-1]["equity"] = realized
            return
        equity_curve.append({"time": _to_ist(t.to_pydatetime()).isoformat(), "equity": realized})
        last_eq_ts = t

    def _flush_be_events(events: list[str]) -> None:
        if active is None:
            return
        pe = active.get("pending_events") or []
        if pe:
            events.extend(pe)
            active["pending_events"] = []

    def _close(exit_ts: datetime, exit_px: float, reason: str, events: list[str]) -> Trade:
        nonlocal active, realized
        assert active is not None
        t = _make_trade(active, exit_ts, exit_px, reason, volume, slip_pct=slip, fee_pct=fee)
        trades.append(t)
        realized += t.pnl
        events.append(f"{reason}@{exit_px:.2f}")
        _push_equity(exit_ts)
        active = None
        return t

    def _tighten_from_aggr(
        hi: float,
        lo: float,
        rng: float,
        sig_t: datetime,
        dlt: float,
        side: str,
    ) -> None:
        """
        Update stop from new AGGR; never move target.
        Always refresh rev_* (latest AGGR) for reverse sizing.
        stop_to_be=0: always tighten (long max/low, short min/high).
        stop_to_be=1: adopt AGGR stop only if past entry (long lo>entry, short hi<entry), then ratchet.
        """
        nonlocal active
        if active is None:
            return
        entry_px = float(active["raw_entry"])
        cur = float(active["stop"])
        if active["is_long"]:
            cand = float(lo)
            if stobe:
                if cand > entry_px:
                    active["stop"] = max(cur, cand)
            else:
                active["stop"] = max(cur, cand)
        else:
            cand = float(hi)
            if stobe:
                if cand < entry_px:
                    active["stop"] = min(cur, cand)
            else:
                active["stop"] = min(cur, cand)
        active["rev_high"] = float(hi)
        active["rev_low"] = float(lo)
        active["rev_range"] = float(rng)
        active["rev_signal_time"] = sig_t
        active["rev_delta_pct"] = float(dlt)
        active["rev_side"] = side

    def _build_active(
        *,
        is_long: bool,
        raw: float,
        stop: float,
        target: float,
        entry_time: datetime,
        tag: str,
        signal_time: datetime,
        signal_high: float,
        signal_low: float,
        signal_delta_pct: float,
        range_: float,
        rev_side: str,
        trail_offset: float = 0.0,
    ) -> dict[str, Any]:
        entry = _apply_slip(raw, is_long=is_long, is_entry=True, slip_pct=slip)
        rng = float(range_)
        range_stop = float(signal_low if is_long else signal_high)
        range_off = _unit_offset(
            raw, 0.0, "range", tick_sz, range_=rng, range_stop=range_stop
        )
        if be_u in ("range", "pct"):
            be_off = range_off
        else:
            be_off = _unit_offset(
                entry, be_val, be_u, tick_sz, range_=rng, range_stop=range_stop
            )
        lock_off = _be_ctc_price_offset(float(entry), volume, slip, fee, ctc)
        if is_long:
            be_arm = float(entry) + be_off
            be_lock = float(entry) + lock_off
        else:
            be_arm = float(entry) - be_off
            be_lock = float(entry) - lock_off
        toff = float(trail_offset) if float(trail_offset or 0) > 0 else (
            _unit_offset(raw, trail_val, trail_u, tick_sz, range_=rng, range_stop=range_stop)
            if trail_on
            else 0.0
        )
        use_stop = bool(sl_live or (trail_on and toff > 0))
        use_target = bool(tp_live)
        return {
            "is_long": is_long,
            "entry": entry,
            "raw_entry": raw,
            "stop": float(stop),
            "target": float(target),
            "entry_time": entry_time,
            "entry_tag": tag,
            "mfe": 0.0,
            "mae": 0.0,
            "signal_time": signal_time,
            "signal_high": float(signal_high),
            "signal_low": float(signal_low),
            "signal_delta_pct": float(signal_delta_pct),
            "range": rng,
            "reverse_on_stop": False,
            "rev_high": float(signal_high),
            "rev_low": float(signal_low),
            "rev_range": rng,
            "rev_signal_time": signal_time,
            "rev_delta_pct": float(signal_delta_pct),
            "rev_side": rev_side,
            "be_enabled": bool(be_on) and be_off > 0,
            "be_moved": False,
            "be_arm": be_arm,
            "be_lock": be_lock,
            "trail_stop": bool(trail_on),
            "trail_offset": toff,
            "trail_tf_sec": max(int(tf_minutes), 1) * 60,
            "stop_init": float(stop),
            "trail_path": (
                [(entry_time, float(stop))]
                if trail_on and abs(float(stop)) < FAR_LEVEL / 10.0
                else []
            ),
            "use_stop": use_stop,
            "use_target": use_target,
            "flip_px": None,
            "mtf_invalid": None,
            "pending_events": [],
        }

    def _levels(
        *,
        raw: float,
        is_long: bool,
        range_: float,
        range_stop: float | None,
    ) -> tuple[float, float, float]:
        far = FAR_LEVEL
        toff = (
            _unit_offset(
                raw, trail_val, trail_u, tick_sz, range_=range_, range_stop=range_stop
            )
            if trail_on
            else 0.0
        )
        if sl_live:
            stop = _price_level(
                raw_entry=raw,
                is_long=is_long,
                unit=sl_u,
                value=sl_val,
                rr=rr,
                range_=range_,
                range_stop=range_stop,
                tick_size=tick_sz,
                is_stop=True,
            )
        elif trail_on and toff > 0:
            stop = raw - toff if is_long else raw + toff
        else:
            stop = raw - far if is_long else raw + far
        if tp_live:
            target = _price_level(
                raw_entry=raw,
                is_long=is_long,
                unit=tp_u,
                value=tp_val,
                rr=rr,
                range_=range_,
                range_stop=range_stop,
                tick_size=tick_sz,
                is_stop=False,
            )
        else:
            target = raw + far if is_long else raw - far
        return stop, target, toff

    def _open_from_orb(
        *,
        is_long: bool,
        raw: float,
        entry_time: datetime,
        tag: str,
        events: list[str],
    ) -> None:
        nonlocal active, pending_reentry
        assert orb is not None
        range_stop = float(orb["low"] if is_long else orb["high"])
        stop, target, toff = _levels(
            raw=raw,
            is_long=is_long,
            range_=float(orb["range"]),
            range_stop=range_stop,
        )
        active = _build_active(
            is_long=is_long,
            raw=raw,
            stop=stop,
            target=target,
            entry_time=entry_time,
            tag=tag,
            signal_time=orb["signal_time"],
            signal_high=float(orb["signal_high"]),
            signal_low=float(orb["signal_low"]),
            signal_delta_pct=float(orb["signal_delta_pct"]),
            range_=float(orb["range"]),
            rev_side=str(orb["signal_side"]),
            trail_offset=toff,
        )
        pending_reentry = None
        events.append(f"{tag}@{active['entry']:.2f}")

    def _open_reverse(
        was: dict[str, Any],
        *,
        entry_time: datetime,
        raw: float,
        tag: str,
        events: list[str],
    ) -> None:
        """Flip using latest AGGR range stored on the closed trade; TP fixed for new trade."""
        nonlocal active, pending_reentry
        is_long = tag == "SR"  # SR closes short → open long; LR closes long → open short
        rng = float(was.get("rev_range") or was["range"])
        hi = float(was.get("rev_high") or was["signal_high"])
        lo = float(was.get("rev_low") or was["signal_low"])
        range_stop = lo if is_long else hi
        stop, target, toff = _levels(
            raw=raw,
            is_long=is_long,
            range_=rng,
            range_stop=range_stop,
        )
        sig_t = was.get("rev_signal_time") or was["signal_time"]
        dlt = float(was.get("rev_delta_pct") or was["signal_delta_pct"])
        side = str(was.get("rev_side") or ("Buy" if is_long else "Sell"))
        active = _build_active(
            is_long=is_long,
            raw=raw,
            stop=stop,
            target=target,
            entry_time=entry_time,
            tag=tag,
            signal_time=sig_t,
            signal_high=hi,
            signal_low=lo,
            signal_delta_pct=dlt,
            range_=rng,
            rev_side=side,
            trail_offset=toff,
        )
        pending_reentry = None
        events.append(f"{tag}@{active['entry']:.2f}")

    def _stamp_rev_aggr(
        hi: float,
        lo: float,
        rng: float,
        sig_t: datetime,
        dlt: float,
        side: str,
    ) -> None:
        if active is None:
            return
        active["rev_high"] = float(hi)
        active["rev_low"] = float(lo)
        active["rev_range"] = float(rng)
        active["rev_signal_time"] = sig_t
        active["rev_delta_pct"] = float(dlt)
        active["rev_side"] = side

    def _arm_flip_from_aggr(
        side: str,
        hi: float,
        lo: float,
        rng: float,
        sig_t: datetime,
        dlt: float,
        events: list[str],
        pro_tag: str = "",
    ) -> None:
        """Dir/Pro: reverse at next bar open. Non-Dir: fill when price takes opposite AGGR H/L."""
        nonlocal aggr_flip, active
        if active is None or not aggr_reverse:
            return
        is_long = bool(active["is_long"])
        if pro:
            if not pro_tag:
                return
            opposite = (is_long and _pro_short_bias(pro_tag)) or (
                (not is_long) and _pro_long_bias(pro_tag)
            )
            stamp_side = "Buy" if _pro_long_bias(pro_tag) else "Sell"
        else:
            opposite = (is_long and side == "Sell") or ((not is_long) and side == "Buy")
            stamp_side = side
        if opposite:
            _stamp_rev_aggr(hi, lo, rng, sig_t, dlt, stamp_side)
            if wait_and_trade:
                active["flip_px"] = float(lo) if is_long else float(hi)
                events.append(f"FLIP-ARM@{active['flip_px']:.2f}")
            else:
                aggr_flip = {"reason": "LR" if is_long else "SR"}
                events.append("FLIP-ARM-NEXT-OPEN")
            return
        if wait_and_trade and active.get("flip_px") is not None:
            events.append("FLIP-CANCEL")
            active["flip_px"] = None
        if aggr_flip is not None:
            events.append("FLIP-CANCEL")
            aggr_flip = None

    def _cancel_stale_setups(events: list[str], why: str) -> None:
        """Drop pending ORB / Directional setups / reverse so Flatten cannot fill next session."""
        nonlocal orb, pending_reentry, aggr_flip, mtf_flip, long_setup, short_setup
        parts: list[str] = []
        if orb is not None:
            parts.append("orb")
            orb = None
        if pending_reentry is not None:
            parts.append("reentry")
            pending_reentry = None
        if aggr_flip is not None:
            parts.append("flip")
            aggr_flip = None
        if mtf_flip is not None:
            parts.append("mtf-flip")
            mtf_flip = None
        if long_setup is not None:
            parts.append("LE-setup")
            long_setup = None
        if short_setup is not None:
            parts.append("SE-setup")
            short_setup = None
        if parts:
            events.append(f"FLAT-CANCEL-{why}:{'+'.join(parts)}")

    def _handle_exit(
        x_ts: datetime,
        x_px: float,
        reason: str,
        events: list[str],
        *,
        until: datetime,
    ) -> bool:
        """Close; on LR/SR try reverse; hard LSL/SSL only if reverse blocked and loss."""
        nonlocal active, tick_i, pending_reentry, aggr_flip
        if active is None:
            return False
        _flush_be_events(events)
        was = active
        is_long = bool(was["is_long"])
        final = reason

        if reason in ("LR", "SR"):
            # SR = reversing short → new long; LR = reversing long → new short
            is_long_new = reason == "SR"
            can_rev = _in_session(x_ts, entry_after, entry_before, hour_set) and (
                (is_long_new and allow_long) or ((not is_long_new) and allow_short)
            )
            profit = (x_px > float(was["entry"])) if is_long else (x_px < float(was["entry"]))
            if can_rev:
                final = reason
            elif profit:
                final = reason  # never LSL/SSL when green
            else:
                final = "LSL" if is_long else "SSL"

            _close(x_ts, x_px, final, events)

            if can_rev:
                _open_reverse(
                    was,
                    entry_time=x_ts,
                    raw=float(x_px),
                    tag=reason,
                    events=events,
                )
                tick_i, y_ts, y_px, y_reason = _scan_ticks_until(
                    book,
                    tick_i,
                    active,
                    until=until,
                    exit_time=exit_time,
                    time_stop_minutes=tstop,
                )
                if y_reason is not None and y_ts is not None and y_px is not None:
                    return _handle_exit(y_ts, y_px, y_reason, events, until=until)
                _flush_be_events(events)
            elif final in ("LSL", "SSL") and re_en == 1:
                pending_reentry = {
                    "is_long": is_long,
                    "level": float(was["raw_entry"]),
                    "stop": float(was["stop"]),
                    "target": float(was["target"]),
                    "signal_time": was["signal_time"],
                    "signal_high": was["signal_high"],
                    "signal_low": was["signal_low"],
                    "signal_delta_pct": was["signal_delta_pct"],
                    "range": was["range"],
                    "signal_side": str(was.get("rev_side") or ("Buy" if is_long else "Sell")),
                }
            return True

        _close(x_ts, x_px, final, events)
        if reason in ("LTX", "STX"):
            _cancel_stale_setups(events, reason)
        else:
            aggr_flip = None
        if reason in ("LSL", "SSL") and re_en == 1:
            pending_reentry = {
                "is_long": is_long,
                "level": float(was["raw_entry"]),
                "stop": float(was["stop"]),
                "target": float(was["target"]),
                "signal_time": was["signal_time"],
                "signal_high": was["signal_high"],
                "signal_low": was["signal_low"],
                "signal_delta_pct": was["signal_delta_pct"],
                "range": was["range"],
                "signal_side": str(was.get("rev_side") or ("Buy" if is_long else "Sell")),
            }
        return True

    for _, row in df.iterrows():
        ot = row["open_time"].to_pydatetime()
        if ot.tzinfo is None:
            ot = ot.replace(tzinfo=timezone.utc)
        bar_end = ot + tf_delta
        o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
        dlt = float(row.get("delta_pct", 0.0))
        vol_q = float(row.get("volume_quote", 0.0))
        delta_q = float(row.get("delta_quote", 0.0))
        vol_b = float(row.get("volume_base", 0.0))
        delta_b = float(row.get("delta_base", 0.0))
        events: list[str] = []
        closed_this_bar = False
        session_flat = _bar_overlaps_flat(ot, bar_end, exit_time)
        if session_flat:
            _cancel_stale_setups(events, "clock")

        mtf_mode, mtf_inv = (None, None)
        if mtf:
            mtf_mode, mtf_inv = mtf_bias_at(mtf_events, ot)
            htf_flipped = (
                last_mtf_mode is not None
                and mtf_mode is not None
                and mtf_mode != last_mtf_mode
            )
            if active is not None:
                active["mtf_invalid"] = mtf_inv
                # Same side as the *new* HTF (short+bear / long+bull) → keep.
                # Against the new HTF → flatten unless the original signal
                # candle is still a legal other-side trade vs the new line.
                if htf_flipped:
                    is_long = bool(active["is_long"])
                    same_side = (is_long and mtf_mode == "bull") or (
                        (not is_long) and mtf_mode == "bear"
                    )
                    if same_side:
                        legal = True
                    elif is_long:
                        legal = _mtf_accept_long(float(active["signal_low"]), mtf_inv)
                    else:
                        legal = _mtf_accept_short(float(active["signal_high"]), mtf_inv)
                    if not legal:
                        tag = "LMTFX" if is_long else "SMTFX"
                        closed_this_bar = _handle_exit(ot, o, tag, events, until=bar_end)
            if long_setup is not None and not _mtf_accept_long(
                float(long_setup["signal_low"]), mtf_inv
            ):
                events.append("LE-SETUP-CANCEL-MTF")
                long_setup = None
            if short_setup is not None and not _mtf_accept_short(
                float(short_setup["signal_high"]), mtf_inv
            ):
                events.append("SE-SETUP-CANCEL-MTF")
                short_setup = None
            if mtf_flip is not None:
                want = str(mtf_flip.get("close_tag") or "")
                keep_flip = (want == "LMTFX" and short_setup is not None) or (
                    want == "SMTFX" and long_setup is not None
                )
                if not keep_flip:
                    events.append("MTF-FLIP-CANCEL")
                    mtf_flip = None

        in_win = _in_session(ot, entry_after, entry_before, hour_set)
        tick_managed = False
        # Directional / Pro: opposite-AGGR reverse fills at this bar's open (same as LE/SE)
        if (
            aggr_reverse
            and not wait_and_trade
            and aggr_flip is not None
            and active is not None
        ):
            want = str(aggr_flip.get("reason") or "")
            side_ok = (want == "LR" and active["is_long"]) or (
                want == "SR" and not active["is_long"]
            )
            if side_ok and in_win and not session_flat:
                tick_i = book.seek(ot, tick_i)
                closed_this_bar = _handle_exit(ot, o, want, events, until=bar_end)
                tick_managed = True
            aggr_flip = None

        # Pro-MTF: opposite whole-candle LTF AGGR flattens at this bar's open
        if mtf and mtf_flip is not None:
            if active is not None:
                want = str(mtf_flip.get("close_tag") or "")
                side_ok = (want == "LMTFX" and active["is_long"]) or (
                    want == "SMTFX" and not active["is_long"]
                )
                if side_ok and in_win and not session_flat:
                    tick_i = book.seek(ot, tick_i)
                    closed_this_bar = _handle_exit(ot, o, want, events, until=bar_end)
                    tick_managed = True
            mtf_flip = None

        # --- manage open on ticks through this bar ---
        if active is not None and not tick_managed:
            tick_i, x_ts, x_px, reason = _scan_ticks_until(
                book,
                tick_i,
                active,
                until=bar_end,
                exit_time=exit_time,
                time_stop_minutes=tstop,
            )
            if reason is not None and x_ts is not None and x_px is not None:
                closed_this_bar = _handle_exit(x_ts, x_px, reason, events, until=bar_end)
            else:
                _flush_be_events(events)

        entered = False

        if wait_and_trade:
            # ORB: advance eligibility; try re-entry then dual-side break
            if orb is not None and orb["signal_time"] < ot:
                orb["bars"] = int(orb.get("bars", 0)) + 1

            if active is None and in_win and not session_flat:
                # If ticks were already consumed this bar (e.g. stop then flat),
                # never fall back to bar-open OHLC — that would timestamp before the exit.
                bar_tick_start = book.seek(ot, 0)
                allow_ohlc_fallback = tick_i <= bar_tick_start

                # Stop re-entry: return to prior entry level
                if pending_reentry is not None:
                    pref = pending_reentry
                    lvl = float(pref["level"])
                    want_long = bool(pref["is_long"])
                    touch = book.first_touch(
                        t0=ot, t1=bar_end, level=lvl, is_long=want_long, start=tick_i
                    )
                    bar_ok = allow_ohlc_fallback and (
                        (h >= lvl) if want_long else (l <= lvl)
                    )
                    if touch is not None or bar_ok:
                        if touch is not None:
                            entry_time = touch[1].to_pydatetime()
                            tick_i = touch[0] + 1
                        else:
                            entry_time = ot
                            tick_i = book.seek(ot, tick_i)
                        raw = lvl
                        tag = "LE" if want_long else "SE"
                        active = _build_active(
                            is_long=want_long,
                            raw=raw,
                            stop=float(pref["stop"]),
                            target=float(pref["target"]),
                            entry_time=entry_time,
                            tag=tag,
                            signal_time=pref["signal_time"],
                            signal_high=float(pref["signal_high"]),
                            signal_low=float(pref["signal_low"]),
                            signal_delta_pct=float(pref["signal_delta_pct"]),
                            range_=float(pref["range"]),
                            rev_side=str(pref["signal_side"]),
                        )
                        pending_reentry = None
                        entered = True
                        events.append(f"{tag}-RE@{active['entry']:.2f}")

                if active is None and orb is not None and int(orb.get("bars", 0)) >= 1:
                    brk = book.first_orb_break(
                        t0=ot,
                        t1=bar_end,
                        high=float(orb["high"]),
                        low=float(orb["low"]),
                        allow_long=allow_long,
                        allow_short=allow_short,
                        start=tick_i,
                    )
                    is_long_e: bool | None = None
                    entry_time = ot
                    if brk is not None:
                        tick_i = brk[0] + 1
                        entry_time = brk[1].to_pydatetime()
                        is_long_e = brk[2]
                    elif allow_ohlc_fallback:
                        # Bar-level crossover proxy: open on far side, range trades through level
                        oh = float(orb["high"])
                        ol = float(orb["low"])
                        hit_l = allow_long and o < oh and h >= oh
                        hit_s = allow_short and o > ol and l <= ol
                        if hit_l and not hit_s:
                            is_long_e = True
                            tick_i = book.seek(ot, tick_i)
                        elif hit_s and not hit_l:
                            is_long_e = False
                            tick_i = book.seek(ot, tick_i)
                        elif hit_l and hit_s:
                            is_long_e = True
                            tick_i = book.seek(ot, tick_i)
                    if is_long_e is not None:
                        raw = float(orb["high"] if is_long_e else orb["low"])
                        tag = "LE" if is_long_e else "SE"
                        _open_from_orb(
                            is_long=is_long_e,
                            raw=raw,
                            entry_time=entry_time,
                            tag=tag,
                            events=events,
                        )
                        entered = True
        else:
            # Directional / Pro-MTF: next eligible bar open
            if mtf:
                mtf_long_ok = bool(
                    long_setup
                    and _mtf_accept_long(float(long_setup["signal_low"]), mtf_inv)
                )
                mtf_short_ok = bool(
                    short_setup
                    and _mtf_accept_short(float(short_setup["signal_high"]), mtf_inv)
                )
            else:
                mtf_long_ok = True
                mtf_short_ok = True

            if active is None:
                # Age setups; drop if price traded through AGGR stop (range SL)
                if long_setup is not None and long_setup["signal_time"] < ot:
                    long_setup["bars"] += 1
                    stop_lvl = float(long_setup["low"])
                    hit_setup = (
                        bool(sl_live)
                        and sl_u == "range"
                        and (o <= stop_lvl or l <= stop_lvl)
                    )
                    if hit_setup:
                        events.append(f"LE-SETUP-INVALID@{stop_lvl:.2f}")
                        long_setup = None
                    elif mtf and long_setup is not None and not mtf_long_ok:
                        events.append("LE-SETUP-CANCEL-MTF")
                        long_setup = None
                if short_setup is not None and short_setup["signal_time"] < ot:
                    short_setup["bars"] += 1
                    stop_lvl = float(short_setup["high"])
                    hit_setup = (
                        bool(sl_live)
                        and sl_u == "range"
                        and (o >= stop_lvl or h >= stop_lvl)
                    )
                    if hit_setup:
                        events.append(f"SE-SETUP-INVALID@{stop_lvl:.2f}")
                        short_setup = None
                    elif mtf and short_setup is not None and not mtf_short_ok:
                        events.append("SE-SETUP-CANCEL-MTF")
                        short_setup = None

            if active is None and in_win and not session_flat:
                bar_tick_start = book.seek(ot, 0)
                # Flat since bar open only — avoids entry_time < prior mid-bar exit
                if tick_i <= bar_tick_start:
                    if (
                        allow_long
                        and mtf_long_ok
                        and long_setup
                        and int(long_setup["bars"]) >= 1
                        and active is None
                    ):
                        raw = o
                        range_stop = float(long_setup["low"])
                        stop, target, toff = _levels(
                            raw=raw,
                            is_long=True,
                            range_=float(long_setup["range"]),
                            range_stop=range_stop,
                        )
                        # Long stop must be strictly below entry (Risk On only)
                        if sl_live and stop >= raw:
                            events.append(f"LE-SKIP-BADSTOP@{stop:.2f}>={raw:.2f}")
                            long_setup = None
                        else:
                            tick_i = book.seek(ot, tick_i)
                            tag = str(long_setup.get("pro_tag") or "LE")
                            active = _build_active(
                                is_long=True,
                                raw=raw,
                                stop=stop,
                                target=target,
                                entry_time=ot,
                                tag=tag,
                                signal_time=long_setup["signal_time"],
                                signal_high=float(long_setup["signal_high"]),
                                signal_low=float(long_setup["signal_low"]),
                                signal_delta_pct=float(long_setup["signal_delta_pct"]),
                                range_=float(long_setup["range"]),
                                rev_side="Buy",
                                trail_offset=toff,
                            )
                            active["mtf_invalid"] = mtf_inv
                            long_setup = short_setup = None
                            entered = True
                            events.append(f"{tag}@{active['entry']:.2f}")

                    if (
                        allow_short
                        and mtf_short_ok
                        and short_setup
                        and int(short_setup["bars"]) >= 1
                        and active is None
                    ):
                        raw = o
                        range_stop = float(short_setup["high"])
                        stop, target, toff = _levels(
                            raw=raw,
                            is_long=False,
                            range_=float(short_setup["range"]),
                            range_stop=range_stop,
                        )
                        # Short stop must be strictly above entry (Risk On only)
                        if sl_live and stop <= raw:
                            events.append(f"SE-SKIP-BADSTOP@{stop:.2f}<={raw:.2f}")
                            short_setup = None
                        else:
                            tick_i = book.seek(ot, tick_i)
                            tag = str(short_setup.get("pro_tag") or "SE")
                            active = _build_active(
                                is_long=False,
                                raw=raw,
                                stop=stop,
                                target=target,
                                entry_time=ot,
                                tag=tag,
                                signal_time=short_setup["signal_time"],
                                signal_high=float(short_setup["signal_high"]),
                                signal_low=float(short_setup["signal_low"]),
                                signal_delta_pct=float(short_setup["signal_delta_pct"]),
                                range_=float(short_setup["range"]),
                                rev_side="Sell",
                                trail_offset=toff,
                            )
                            active["mtf_invalid"] = mtf_inv
                            long_setup = short_setup = None
                            entered = True
                            events.append(f"{tag}@{active['entry']:.2f} TP={target:.2f}")

        # same-bar / remainder-of-bar tick exit after entry
        if entered and active is not None:
            tick_i, x_ts, x_px, reason = _scan_ticks_until(
                book,
                tick_i,
                active,
                until=bar_end,
                exit_time=exit_time,
                time_stop_minutes=tstop,
            )
            if reason is not None and x_ts is not None and x_px is not None:
                closed_this_bar = _handle_exit(x_ts, x_px, reason, events, until=bar_end)
            else:
                _flush_be_events(events)

        # Aggressive candle: only inside the session window (default 05:30–21:00 IST).
        # Outside that window we neither list AGGR nor arm Directional/ORB setups.
        # VWAP (±σ) comes from precomputed full-bar indicators (or live fallback).
        if has_ind_vwap:
            vwap_px = float(row["ind_vwap"])
            vwap_sd = float(row["ind_vwap_sd"])
        else:
            typical = (h + l + c) / 3.0
            vol_for_vwap = vol_q if vol_q > 0 else vol_b
            assert vwap_tr is not None
            vwap_px, vwap_sd = vwap_tr.update(ot, typical, vol_for_vwap)

        if abs(dlt) >= threshold and _in_session(ot, entry_after, entry_before, hour_set):
            side = "Buy" if dlt >= threshold else "Sell"
            rng = h - l
            ltp = float(prev_close) if prev_close is not None else o
            vwap_ok = _outside_vwap_nsigma(h, l, vwap_px, vwap_sd, sigma_n)
            pro_tag = ""
            if pro:
                if vwap_ok:
                    pro_tag = _classify_pro_tag(dlt, threshold, h, l, ltp)
                else:
                    events.append(f"AGGR-SKIP-VWAP{int(sigma_n)}S")
            agg = Aggressive(
                time=_to_ist(ot),
                side=side,
                open=o,
                high=h,
                low=l,
                close=c,
                volume_usdt=vol_q,
                delta_usdt=delta_q,
                delta_pct=dlt,
                range=rng,
                pro_tag=pro_tag,
                vwap_ok=vwap_ok,
            )
            aggressive.append(agg)
            if pro and pro_tag:
                events.append(f"AGGR-{pro_tag}")
            else:
                events.append(f"AGGR-{side.upper()}")

            # Non-Directional only: tighten stop from new AGGR (TP stays fixed)
            if allow_trail and active is not None:
                _tighten_from_aggr(h, l, rng, ot, dlt, side)

            if aggr_reverse and active is not None:
                _arm_flip_from_aggr(side, h, l, rng, ot, dlt, events, pro_tag=pro_tag)

            if session_flat:
                events.append("AGGR-SKIP-FLAT")
            elif wait_and_trade:
                # Any AGGR → shared ORB range (both sides), cancel stop re-entry wait
                if allow_long or allow_short:
                    orb = {
                        "signal_time": ot,
                        "high": h,
                        "low": l,
                        "range": rng,
                        "bars": 0,
                        "signal_high": h,
                        "signal_low": l,
                        "signal_delta_pct": dlt,
                        "signal_side": side,
                    }
                    pending_reentry = None
            elif pro:
                # Pro: arm only when flat — AGGR during an open trade must not queue
                # a next entry after LT/ST (avoids "LE with no post-exit AGGR").
                if active is None:
                    if pro_tag and _pro_long_bias(pro_tag) and allow_long:
                        long_setup = {
                            "signal_time": ot,
                            "high": h,
                            "low": l,
                            "range": rng,
                            "bars": 0,
                            "signal_high": h,
                            "signal_low": l,
                            "signal_delta_pct": dlt,
                            "pro_tag": pro_tag,
                        }
                        if short_setup is not None:
                            events.append("SE-SETUP-CANCEL")
                            short_setup = None
                    elif pro_tag and _pro_short_bias(pro_tag) and allow_short:
                        short_setup = {
                            "signal_time": ot,
                            "high": h,
                            "low": l,
                            "range": rng,
                            "bars": 0,
                            "signal_high": h,
                            "signal_low": l,
                            "signal_delta_pct": dlt,
                            "pro_tag": pro_tag,
                        }
                        if long_setup is not None:
                            events.append("LE-SETUP-CANCEL")
                            long_setup = None
            else:
                # Directional / Pro-MTF. Pro-MTF: both sides of the current HTF line
                # (whole candle). Opposite qualifier while in a trade → flatten next open.
                mtf_long_arm = (not mtf) or _mtf_accept_long(l, mtf_inv)
                mtf_short_arm = (not mtf) or _mtf_accept_short(h, mtf_inv)
                if mtf and (mtf_mode is None or mtf_inv is None):
                    mtf_long_arm = mtf_short_arm = False

                def _arm_ltf_setup(is_long: bool) -> dict[str, Any]:
                    return {
                        "signal_time": ot,
                        "high": h,
                        "low": l,
                        "range": rng,
                        "bars": 0,
                        "signal_high": h,
                        "signal_low": l,
                        "signal_delta_pct": dlt,
                    }

                if mtf and active is not None:
                    if (
                        active["is_long"]
                        and dlt <= -threshold
                        and mtf_short_arm
                        and allow_short
                    ):
                        mtf_flip = {"close_tag": "LMTFX"}
                        short_setup = _arm_ltf_setup(False)
                        long_setup = None
                        events.append("MTF-FLIP-ARM-SE")
                    elif (
                        (not active["is_long"])
                        and dlt >= threshold
                        and mtf_long_arm
                        and allow_long
                    ):
                        mtf_flip = {"close_tag": "SMTFX"}
                        long_setup = _arm_ltf_setup(True)
                        short_setup = None
                        events.append("MTF-FLIP-ARM-LE")
                    elif (
                        (active["is_long"] and dlt >= threshold)
                        or ((not active["is_long"]) and dlt <= -threshold)
                    ):
                        if mtf_flip is not None:
                            events.append("MTF-FLIP-CANCEL")
                            mtf_flip = None
                elif active is None:
                    can_long = allow_long and mtf_long_arm
                    can_short = allow_short and mtf_short_arm
                    if dlt >= threshold and can_long:
                        long_setup = _arm_ltf_setup(True)
                        if short_setup is not None:
                            events.append("SE-SETUP-CANCEL")
                            short_setup = None
                    if dlt <= -threshold and can_short:
                        short_setup = _arm_ltf_setup(False)
                        if long_setup is not None:
                            events.append("LE-SETUP-CANCEL")
                            long_setup = None

        if mtf:
            last_mtf_mode = mtf_mode
        prev_close = c

        # Bar-open equity only when no intrabar exit already stamped a later time
        if not closed_this_bar:
            _push_equity(ot)
        bar_rows.append(_bar_dict(ot, o, h, l, c, vol_q, delta_q, vol_b, delta_b, dlt, events))

    # Flatten any leftover position on remaining ticks / last trade price
    if active is not None:
        events_end: list[str] = []
        # Drain flips until flat or no more exit
        guard = 0
        while active is not None and guard < 64:
            guard += 1
            tick_i, x_ts, x_px, reason = _scan_ticks_until(
                book,
                tick_i,
                active,
                until=pd.Timestamp("2100-01-01", tz="UTC"),
                exit_time=exit_time,
                time_stop_minutes=tstop,
            )
            if reason is not None and x_ts is not None and x_px is not None:
                _handle_exit(
                    x_ts,
                    x_px,
                    reason,
                    events_end,
                    until=pd.Timestamp("2100-01-01", tz="UTC").to_pydatetime(),
                )
                if reason not in ("LR", "SR"):
                    break
                continue
            break
        if active is not None:
            _flush_be_events(events_end)
            if book.n > 0 and tick_i > 0:
                last_i = min(tick_i, book.n) - 1
                ts = pd.Timestamp(book.ts[last_i], tz="UTC").to_pydatetime()
                px = float(book.px[last_i])
                _close(ts, px, "EOD", events_end)
            elif not df.empty:
                last_ot = df["open_time"].iloc[-1].to_pydatetime()
                if last_ot.tzinfo is None:
                    last_ot = last_ot.replace(tzinfo=timezone.utc)
                _close(
                    last_ot + tf_delta - timedelta(milliseconds=1),
                    float(df["close"].iloc[-1]),
                    "EOD",
                    events_end,
                )

    wins = sum(1 for t in trades if t.pnl > 0)
    from backend.engine.metrics import compute_trade_metrics

    metrics = compute_trade_metrics(
        trades, equity_curve, bars_count=len(bar_rows), tf_minutes=tf_minutes
    )
    categories = metrics.pop("categories", None)
    total_slip = sum(float(t.slippage) for t in trades)
    total_fee = sum(float(t.fee) for t in trades)
    entry_tags = {
        r: sum(1 for t in trades if t.entry_tag == r)
        for r in sorted({t.entry_tag for t in trades})
    }
    stats = {
        "trades": len(trades),
        "aggressive": len(aggressive),
        "net_pnl": round(sum(t.pnl for t in trades), 6),
        "win_rate": round(wins / len(trades) * 100, 2) if trades else 0.0,
        "total_slippage": round(total_slip, 6),
        "total_fees": round(total_fee, 6),
        "gross_pnl": round(sum(float(t.pnl) + float(t.fee) for t in trades), 6) if trades else 0.0,
        "total_cost": round(total_slip + total_fee, 6),
        "re_entry": re_en,
        "stop_to_be": stobe,
        "break_even": int(be_on),
        "break_even_pct": round(be_frac * 100.0, 2),
        "strategy_mode": (
            "pro_mtf"
            if mtf
            else ("pro" if pro else ("non_directional" if wait_and_trade else "directional"))
        ),
        "pro_mode": int(pro),
        "pro_mtf_mode": int(mtf),
        "base_tf_minutes": int(base_tf) if mtf else 0,
        "base_threshold": float(base_thr) if mtf else 0.0,
        "pro_vwap_sigma": sigma_n,
        "sl_tp_unit": sl_u if sl_u == tp_u else f"{sl_u}/{tp_u}",
        "sl_on": int(sl_live),
        "tp_on": int(tp_live),
        "sl_unit": sl_u,
        "tp_unit": tp_u,
        "stop_loss": sl_val,
        "take_profit": tp_val,
        "trail_stop": int(trail_on),
        "risk_on": int(risk_live),
        "trail_unit": trail_u,
        "trail_value": trail_val,
        "be_unit": be_u,
        "be_value": be_val,
        "be_ctc": round(ctc, 4),
        "tick_session_slice": {
            "after_min": int(entry_after),
            "before_min": int(entry_before),
            "flat_min": int(exit_time),
            "tod_lo": int(tick_lo),
            "tod_hi": int(tick_hi),
            "buffer_min": int(buf),
            "ticks_used": int(book.n),
        },
        "exits": {
            r: sum(1 for t in trades if t.exit_reason == r)
            for r in sorted({t.exit_reason for t in trades})
        },
        "entry_tags": entry_tags,
        "engine": ENGINE_ID,
        **{k: v for k, v in metrics.items() if k not in ("trades", "net_pnl", "win_rate")},
    }
    if categories is not None:
        stats["categories"] = categories

    mtf_bias_rows: list[dict[str, Any]] = []
    if mtf and mtf_events:
        for active_from, mode, inv in mtf_events:
            mtf_bias_rows.append(
                {
                    "time": _to_ist(active_from.to_pydatetime()).isoformat(),
                    "mode": mode,
                    "invalid": round(float(inv), 2),
                }
            )

    return BacktestResult(
        symbol=symbol,
        tf_minutes=tf_minutes,
        wait_and_trade=wait_and_trade,
        rr=rr,
        volume=volume,
        threshold=threshold,
        trades=trades,
        aggressive=aggressive,
        bars=bar_rows,
        equity=equity_curve,
        stats=stats,
        re_entry=re_en,
        stop_to_be=stobe,
        break_even=int(be_on),
        break_even_pct=round(be_frac * 100.0, 2),
        pro_mode=int(pro),
        pro_vwap_sigma=sigma_n,
        pro_mtf_mode=int(mtf),
        base_tf_minutes=int(base_tf) if mtf else 0,
        base_threshold=float(base_thr) if mtf else 0.0,
        mtf_bias=mtf_bias_rows if mtf else [],
    )


def _bar_dict(ot, o, h, l, c, vol_q, delta_q, vol_b, delta_b, dlt, events):
    return {
        "time": int(ot.replace(tzinfo=timezone.utc).timestamp()) if ot.tzinfo else int(ot.timestamp()),
        "time_iso": _to_ist(ot).isoformat(),
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "volume": vol_q,
        "delta": delta_q,
        "volume_quote": vol_q,
        "delta_quote": delta_q,
        "volume_base": vol_b,
        "delta_base": delta_b,
        "delta_pct": dlt,
        "events": events,
    }


def result_to_jsonable(r: BacktestResult) -> dict[str, Any]:
    from backend.engine.formatting import round_obj

    def ser_trade(t: Trade) -> dict[str, Any]:
        d = asdict(t)
        for k in ("entry_time", "exit_time", "signal_time", "be_moved_time"):
            if d.get(k) is not None:
                d[k] = d[k].isoformat()
        return round_obj(d)

    def ser_agg(a: Aggressive) -> dict[str, Any]:
        d = asdict(a)
        d["time"] = d["time"].isoformat()
        return round_obj(d)

    def ser_bar(b: dict[str, Any]) -> dict[str, Any]:
        out = dict(b)
        for k in (
            "open",
            "high",
            "low",
            "close",
            "volume",
            "delta",
            "volume_quote",
            "delta_quote",
            "volume_base",
            "delta_base",
            "delta_pct",
        ):
            if k in out and isinstance(out[k], (int, float)):
                out[k] = round(float(out[k]), 2)
        return out

    return {
        "symbol": r.symbol,
        "tf_minutes": r.tf_minutes,
        "wait_and_trade": r.wait_and_trade,
        "pro_mode": int(r.pro_mode),
        "pro_mtf_mode": int(r.pro_mtf_mode),
        "base_tf_minutes": int(r.base_tf_minutes),
        "base_threshold": round(float(r.base_threshold), 2),
        "pro_vwap_sigma": round(float(r.pro_vwap_sigma), 2),
        "rr": round(float(r.rr), 2),
        "volume": round(float(r.volume), 2),
        "threshold": round(float(r.threshold), 2),
        "re_entry": int(r.re_entry),
        "stop_to_be": int(r.stop_to_be),
        "break_even": int(r.break_even),
        "break_even_pct": round(float(r.break_even_pct), 2),
        "stats": round_obj(r.stats),
        "trades": [ser_trade(t) for t in r.trades],
        "aggressive": [ser_agg(a) for a in r.aggressive],
        "bars": [ser_bar(b) for b in r.bars],
        "equity": [{"time": e["time"], "equity": round(float(e["equity"]), 2)} for e in r.equity],
        "mtf_bias": [
            {
                "time": e["time"],
                "mode": e["mode"],
                "invalid": round(float(e["invalid"]), 2),
            }
            for e in (r.mtf_bias or [])
        ],
        "engine": ENGINE_ID,
    }


def load_bars(symbol: str = "ETHUSDT", tf_minutes: int = 15) -> pd.DataFrame:
    from backend.engine.bars import load_or_build_bars

    return load_or_build_bars(symbol, tf_minutes)


def write_parity_report(r: BacktestResult, path: Path | None = None) -> Path:
    LOGS.mkdir(parents=True, exist_ok=True)
    path = path or LOGS / f"parity-{r.symbol}-{r.tf_minutes}m-{datetime.now().strftime('%Y%m%d-%H%M%S')}.txt"
    lines = [
        f"=== volume_delta hybrid ({ENGINE_ID}) ===",
        f"Symbol={r.symbol} TF={r.tf_minutes}m WaitAndTrade={r.wait_and_trade} RR={r.rr} Vol={r.volume}",
        f"Stats: {r.stats}",
        "",
        "--- AGGRESSIVE ---",
    ]
    for a in r.aggressive:
        lines.append(
            f"{a.time:%Y-%m-%d %H:%M} {a.side:4} Δ%={a.delta_pct:.1f} H={a.high:.2f} L={a.low:.2f} R={a.range:.2f}"
        )
    lines.append("")
    lines.append("--- TRADES ---")
    for i, t in enumerate(r.trades, 1):
        lines.append(
            f"#{i} {t.side} {t.exit_reason} PnL={t.pnl:.4f} "
            f"Entry {t.entry_time:%Y-%m-%d %H:%M:%S} @{t.entry_price:.2f} → "
            f"Exit {t.exit_time:%Y-%m-%d %H:%M:%S} @{t.exit_price:.2f}"
        )
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def check_parity_aug1(r: BacktestResult) -> list[str]:
    """ETHUSDT 15m Aug 1–2 gate: SE@15:30 1866.98 + ST@1864.49 ~+0.02."""
    errors: list[str] = []
    if len(r.aggressive) < 1:
        errors.append("expected >=1 aggressive candle")
    else:
        a = r.aggressive[0]
        if not (a.time.hour == 15 and a.time.minute == 15):
            errors.append(f"aggressive time want 15:15 got {a.time:%H:%M}")
        if a.side != "Sell":
            errors.append(f"aggressive side want Sell got {a.side}")
    if len(r.trades) != 1:
        errors.append(f"trades want 1 got {len(r.trades)}")
        return errors
    t = r.trades[0]
    if t.side != "Short" or t.exit_reason != "ST":
        errors.append(f"trade want Short/ST got {t.side}/{t.exit_reason}")
    if not (t.entry_time.hour == 15 and t.entry_time.minute == 30):
        errors.append(f"entry time want 15:30 got {t.entry_time:%H:%M}")
    if abs(t.entry_price - 1866.98) > 0.02:
        errors.append(f"entry price want ~1866.98 got {t.entry_price}")
    if abs(t.exit_price - 1864.49) > 0.05:
        errors.append(f"exit price want ~1864.49 got {t.exit_price}")
    if abs(t.pnl - 0.02) > 0.005:
        errors.append(f"pnl want ~0.02 got {t.pnl}")
    return errors
