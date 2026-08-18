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


def _excursions(active: dict[str, Any], h: float, l: float) -> None:
    entry = active["entry"]
    if active["is_long"]:
        active["mfe"] = max(float(active.get("mfe", 0.0)), h - entry)
        active["mae"] = max(float(active.get("mae", 0.0)), entry - l)
    else:
        active["mfe"] = max(float(active.get("mfe", 0.0)), entry - l)
        active["mae"] = max(float(active.get("mae", 0.0)), h - entry)


def _apply_slip(px: float, *, is_long: bool, is_entry: bool, slip_pct: float) -> float:
    """Worsen fill by slip_pct (% of price)."""
    if slip_pct <= 0:
        return px
    f = slip_pct / 100.0
    if is_entry:
        return px * (1.0 + f) if is_long else px * (1.0 - f)
    return px * (1.0 - f) if is_long else px * (1.0 + f)


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
    entry = float(active["entry"])
    raw_entry = float(active.get("raw_entry", entry))
    exit_px = _apply_slip(px, is_long=is_long, is_entry=False, slip_pct=slip_pct)
    pnl = (exit_px - entry) * volume if is_long else (entry - exit_px) * volume
    slip_cost = (abs(entry - raw_entry) + abs(exit_px - px)) * volume
    fee = 0.0
    if fee_pct > 0:
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
    # True when AGGR is outside VWAP ±Nσ (Pro qualifier)
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


def _to_ist(ts: pd.Timestamp | datetime) -> datetime:
    if isinstance(ts, pd.Timestamp):
        ts = ts.to_pydatetime()
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(IST)


def _in_window(ts: datetime, after_min: int, before_min: int) -> bool:
    ist = _to_ist(ts)
    tod = ist.hour * 60 + ist.minute
    return after_min <= tod < before_min


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
    """Pro qualifier: candle must touch above +Nσ or below −Nσ."""
    n = float(n_sigma)
    if n <= 0 or not (stdev > 0 and np.isfinite(vwap)):
        return False
    return high >= vwap + n * stdev or low <= vwap - n * stdev


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


def _as_utc_ts(ts: datetime | pd.Timestamp) -> pd.Timestamp:
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        return t.tz_localize("UTC")
    return t.tz_convert("UTC")


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
        """First tick in [t0, t1) that breaks ORB high (long) or low (short)."""
        i = self.seek(t0, start)
        end = self.seek(t1, i)
        while i < end:
            px = float(self.px[i])
            hit_long = allow_long and px >= high
            hit_short = allow_short and px <= low
            if hit_long or hit_short:
                # Same tick both sides (degenerate range): prefer long
                is_long = bool(hit_long)
                return i, pd.Timestamp(self.ts[i], tz="UTC"), is_long
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
            start = t0.strftime("%Y-%m-%d")
            # exclusive end = day after last bar open (+1 day cushion for last bar ticks)
            end = (last + timedelta(days=2)).strftime("%Y-%m-%d")
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
    Directional BreakEven: when arm touched once, move stop to BE% lock (no exit).
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

        ist = _to_ist(ts)
        if ist.hour * 60 + ist.minute >= exit_time:
            return i + 1, ts, px, ("LTX" if is_long else "STX")

        if tstop > 0:
            held_min = (ts - entry_ts).total_seconds() / 60.0
            if held_min >= tstop:
                return i + 1, ts, px, "TTS"

        # Directional BE: arm at +1R / -1R, lock stop at BE%×R (once)
        if active.get("be_enabled") and not active.get("be_moved"):
            arm = float(active["be_arm"])
            lock = float(active["be_lock"])
            armed = (px >= arm) if is_long else (px <= arm)
            if armed:
                active["stop"] = lock
                active["be_moved"] = True
                pe = active.setdefault("pending_events", [])
                pe.append(f"BE@{lock:.2f}")
                stop = lock

        if is_long:
            if px <= stop:
                if active.get("reverse_on_stop", True):
                    return i + 1, ts, stop, "LR"  # reversing the long
                # After BreakEven lock, stop fill is LB (not a hard LSL)
                if active.get("be_moved"):
                    return i + 1, ts, stop, "LB"
                return i + 1, ts, stop, "LSL"
            if px >= target:
                return i + 1, ts, target, "LT"
        else:
            if px >= stop:
                if active.get("reverse_on_stop", True):
                    return i + 1, ts, stop, "SR"  # reversing the short
                if active.get("be_moved"):
                    return i + 1, ts, stop, "SB"
                return i + 1, ts, stop, "SSL"
            if px <= target:
                return i + 1, ts, target, "ST"
        i += 1

    return i, None, None, None


def run_backtest(
    bars: pd.DataFrame,
    *,
    symbol: str = "ETHUSDT",
    tf_minutes: int = 15,
    wait_and_trade: bool = False,
    rr: float = 1.0,
    volume: float = 0.01,
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
) -> BacktestResult:
    """
    Hybrid engine: bar AGGR/entry levels + tick SL/TP/session fills.

    Session (IST, entry_after…entry_before, default 05:30–21:00):
      Only bars inside this window can form Aggressive candles / arm setups.
      Entries also require the entry bar open to fall inside the window.

    Performance:
      Session indicators (VWAP ±σ, …) are precomputed on *full* bars.
      Ticks are sliced to After → max(Before, Flat) (+ TF buffer) so a 2h/4h/6h
      window does not require loading overnight ticks.

    Directional (wait_and_trade=False, pro_mode=False) — Baseline:
      Buy AGGR → long only; Sell AGGR → short only; next-bar open
      Fixed SL/TP; optional BreakEven (arm=1R → lock stop at BE%×R once)
      No reverse / AGGR trail / re-entry

    Non-Directional (wait_and_trade=True) — ORB + Reverse:
      Any AGGR → shared range; break high/low for LE/SE
      Fixed TP; stop may tighten on new AGGR; stop hit → LR/SR reverse

    Pro (pro_mode=True; wait_and_trade ignored/forced off):
      Classify AGGR as Lo/Sh/Se/Co vs prior close (LTP).
      Qualifier: candle must be outside Binance VWAP ±Nσ (05:30 IST session; N=1/2/3).
      Long entries from Lo|Co; Short from Sh|Se; next-bar open (Directional-style).
      Optional BreakEven; no reverse / ORB trail.
    """
    pro = bool(pro_mode)
    if pro:
        wait_and_trade = False
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
    allow_reverse = bool(wait_and_trade) and not pro
    allow_trail = bool(wait_and_trade) and not pro
    # BreakEven: Directional + Pro; lock fraction of range (default 50%)
    be_on = (pro or not wait_and_trade) and (1 if int(break_even or 0) else 0)
    be_frac = max(0.01, min(1.0, float(break_even_pct if break_even_pct is not None else 50) / 100.0))
    tf_delta = timedelta(minutes=int(tf_minutes))
    hour_set = _parse_allowed_hours(allowed_entry_hours)

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
            start = t0.strftime("%Y-%m-%d")
            end = (last + timedelta(days=2)).strftime("%Y-%m-%d")
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
    ) -> dict[str, Any]:
        entry = _apply_slip(raw, is_long=is_long, is_entry=True, slip_pct=slip)
        rng = float(range_)
        # Directional BE: arm at 1×R from raw entry, lock stop at BE%×R
        if is_long:
            be_arm = float(raw) + rng
            be_lock = float(raw) + be_frac * rng
        else:
            be_arm = float(raw) - rng
            be_lock = float(raw) - be_frac * rng
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
            "reverse_on_stop": allow_reverse,
            "rev_high": float(signal_high),
            "rev_low": float(signal_low),
            "rev_range": rng,
            "rev_signal_time": signal_time,
            "rev_delta_pct": float(signal_delta_pct),
            "rev_side": rev_side,
            "be_enabled": bool(be_on),
            "be_moved": False,
            "be_arm": be_arm,
            "be_lock": be_lock,
            "pending_events": [],
        }

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
        stop = float(orb["low"] if is_long else orb["high"])
        target = raw + float(orb["range"]) * rr if is_long else raw - float(orb["range"]) * rr
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
        stop = lo if is_long else hi
        target = raw + rng * rr if is_long else raw - rng * rr
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
        )
        pending_reentry = None
        events.append(f"{tag}@{active['entry']:.2f}")

    def _handle_exit(
        x_ts: datetime,
        x_px: float,
        reason: str,
        events: list[str],
        *,
        until: datetime,
    ) -> bool:
        """Close; on LR/SR try reverse; hard LSL/SSL only if reverse blocked and loss."""
        nonlocal active, tick_i, pending_reentry
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

        # --- manage open on ticks through this bar ---
        if active is not None:
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
        in_win = _in_session(ot, entry_after, entry_before, hour_set)

        if wait_and_trade:
            # ORB: advance eligibility; try re-entry then dual-side break
            if orb is not None and orb["signal_time"] < ot:
                orb["bars"] = int(orb.get("bars", 0)) + 1

            if active is None and in_win:
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
                        # OHLC fallback only when no ticks consumed yet this bar
                        hit_l = allow_long and h >= float(orb["high"])
                        hit_s = allow_short and l <= float(orb["low"])
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
            # Directional Wait=false: next eligible bar open (skip if ticks already used this bar)
            if active is None:
                # Age setups and drop them if price already traded through the stop
                # (stale AGGR while another trade was open → inverted stop on entry).
                if long_setup is not None and long_setup["signal_time"] < ot:
                    long_setup["bars"] += 1
                    stop_lvl = float(long_setup["low"])
                    if o <= stop_lvl or l <= stop_lvl:
                        events.append(f"LE-SETUP-INVALID@{stop_lvl:.2f}")
                        long_setup = None
                if short_setup is not None and short_setup["signal_time"] < ot:
                    short_setup["bars"] += 1
                    stop_lvl = float(short_setup["high"])
                    if o >= stop_lvl or h >= stop_lvl:
                        events.append(f"SE-SETUP-INVALID@{stop_lvl:.2f}")
                        short_setup = None

            if active is None and in_win:
                bar_tick_start = book.seek(ot, 0)
                # Flat since bar open only — avoids entry_time < prior mid-bar exit
                if tick_i <= bar_tick_start:
                    if allow_long and long_setup and int(long_setup["bars"]) >= 1 and active is None:
                        raw = o
                        stop = float(long_setup["low"])
                        # Long stop must be strictly below entry
                        if stop >= raw:
                            events.append(f"LE-SKIP-BADSTOP@{stop:.2f}>={raw:.2f}")
                            long_setup = None
                        else:
                            target = raw + float(long_setup["range"]) * rr
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
                            )
                            long_setup = short_setup = None
                            entered = True
                            events.append(f"{tag}@{active['entry']:.2f}")

                    if allow_short and short_setup and int(short_setup["bars"]) >= 1 and active is None:
                        raw = o
                        stop = float(short_setup["high"])
                        # Short stop must be strictly above entry
                        if stop <= raw:
                            events.append(f"SE-SKIP-BADSTOP@{stop:.2f}<={raw:.2f}")
                            short_setup = None
                        else:
                            target = raw - float(short_setup["range"]) * rr
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
                            )
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

            if wait_and_trade:
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
                # Pro: only arm when VWAP±Nσ qualifier + Lo/Sh/Se/Co tag
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
                # Directional: opposite AGGR cancels a pending same-side wait
                # (avoids entering long after later sells already invalidated the range).
                if dlt >= threshold and allow_long:
                    long_setup = {
                        "signal_time": ot,
                        "high": h,
                        "low": l,
                        "range": rng,
                        "bars": 0,
                        "signal_high": h,
                        "signal_low": l,
                        "signal_delta_pct": dlt,
                    }
                    if short_setup is not None:
                        events.append("SE-SETUP-CANCEL")
                        short_setup = None
                if dlt <= -threshold and allow_short:
                    short_setup = {
                        "signal_time": ot,
                        "high": h,
                        "low": l,
                        "range": rng,
                        "bars": 0,
                        "signal_high": h,
                        "signal_low": l,
                        "signal_delta_pct": dlt,
                    }
                    if long_setup is not None:
                        events.append("LE-SETUP-CANCEL")
                        long_setup = None

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
        "re_entry": re_en,
        "stop_to_be": stobe,
        "break_even": int(be_on),
        "break_even_pct": round(be_frac * 100.0, 2),
        "strategy_mode": (
            "pro" if pro else ("non_directional" if wait_and_trade else "directional")
        ),
        "pro_mode": int(pro),
        "pro_vwap_sigma": sigma_n,
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
        for k in ("entry_time", "exit_time", "signal_time"):
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
