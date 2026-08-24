"""Brute-force parameter grid with quant performance metrics + common filters."""
from __future__ import annotations

import math
import os
import shutil
import tempfile
from collections.abc import Callable, Iterator
from concurrent.futures import ProcessPoolExecutor, as_completed
from itertools import product
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import pandas as pd

from backend.engine.metrics import compute_trade_metrics
from backend.engine.volume_delta import (
    attach_session_indicators,
    run_backtest,
    slice_ticks_to_session,
)

ProgressCb = Callable[[int, int], None]

IST = ZoneInfo("Asia/Kolkata")

# Intraday time-optimizer steps (no 15m — too noisy / too many combos)
ALLOWED_TIME_STEPS = frozenset({30, 60})

# Per-process state for parallel workers (set by _worker_init)
_W_BARS: pd.DataFrame | None = None
_W_TICKS: pd.DataFrame | None = None
_W_COMMON: dict[str, Any] | None = None
_W_BASE: dict[int, pd.DataFrame] | None = None

_DOW = {
    "mon": 0,
    "tue": 1,
    "wed": 2,
    "thu": 3,
    "fri": 4,
    "sat": 5,
    "sun": 6,
    "0": 0,
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
}

_METRIC_COLUMNS = [
    "net_pnl",
    "sharpe",
    "sortino",
    "sqn",
    "profit_factor",
    "expectancy",
    "e_ratio",
    "avg_mfe",
    "avg_mae",
    "win_rate",
    "max_drawdown",
    "calmar",
    "recovery_factor",
    "payoff_ratio",
    "max_consec_wins",
    "max_consec_losses",
    "kelly_fraction",
    "ulcer_index",
    "total_slippage",
    "total_fees",
    "total_cost",
    "gross_pnl",
    "trades",
]


def _expand_range(lo: float, hi: float, step: float, *, limit: int = 500) -> list[float]:
    """Inclusive arithmetic sequence lo…hi by step (float-safe)."""
    if not (step > 0) or not (hi >= lo - 1e-15):
        return [float(lo)]
    out: list[float] = []
    n = int(math.floor((hi - lo) / step + 1e-9)) + 1
    for i in range(min(n, limit)):
        v = lo + i * step
        if v > hi + abs(step) * 1e-9:
            break
        out.append(float(f"{v:.12g}"))
    return out or [float(lo)]


def _parse_floats(raw: str | Iterable[float]) -> list[float]:
    """
    Parse a float grid.
    Accepts comma lists ('40,50,60') or range 'min:max:step' / 'min-max/step'.
    """
    if not isinstance(raw, str):
        return [float(x) for x in raw]
    s = str(raw).strip()
    if not s:
        return []
    # Range forms (no commas): 40:60:10  or  0.5-2/0.5
    if "," not in s:
        if ":" in s:
            parts = [p.strip() for p in s.split(":")]
            if len(parts) == 3:
                return _expand_range(float(parts[0]), float(parts[1]), float(parts[2]))
        if "-" in s and "/" in s:
            left, step_s = s.rsplit("/", 1)
            a, b = left.split("-", 1)
            return _expand_range(float(a.strip()), float(b.strip()), float(step_s.strip()))
    parts = [p.strip() for p in s.split(",") if p.strip()]
    return [float(p) for p in parts]


def _parse_bools(raw: str | Iterable[bool]) -> list[bool]:
    if isinstance(raw, str):
        out: list[bool] = []
        for p in raw.split(","):
            p = p.strip().lower()
            if p in ("1", "true", "t", "yes", "y"):
                out.append(True)
            elif p in ("0", "false", "f", "no", "n"):
                out.append(False)
        return out
    return [bool(x) for x in raw]


def _parse_strategy_flags(raw: str | Iterable[Any]) -> list[tuple[bool, bool, bool]]:
    """
    Parse strategy grid into (wait_and_trade, pro_mode, pro_mtf_mode) triples.
    Accepts: false/true/pro/pro_mtf (and aliases).
    """
    if not isinstance(raw, str):
        return [(bool(x), False, False) for x in raw]
    out: list[tuple[bool, bool, bool]] = []
    for p in raw.split(","):
        p = p.strip().lower().replace("-", "_")
        if p in ("pro_mtf", "mtf", "pmtf", "promtf"):
            out.append((False, False, True))
        elif p in ("pro", "p"):
            out.append((False, True, False))
        elif p in ("1", "true", "t", "yes", "y", "non_directional", "nd"):
            out.append((True, False, False))
        elif p in ("0", "false", "f", "no", "n", "directional", "dir"):
            out.append((False, False, False))
    return out


def _parse_sigmas(raw: str | Iterable[float] | None, fallback: float = 2.0) -> list[float]:
    """Snap Pro VWAP σ grid to {1, 2, 3}."""
    if raw is None or (isinstance(raw, str) and not str(raw).strip()):
        vals = [float(fallback or 2)]
    else:
        vals = _parse_floats(raw)
    out: list[float] = []
    for s in vals:
        v = min((1.0, 2.0, 3.0), key=lambda x: abs(x - float(s)))
        if v not in out:
            out.append(v)
    return out or [2.0]


def _parse_re_entry_flags(raw: str | Iterable[int] | None) -> list[int]:
    """Parse re-entry grid: 0 and/or 1."""
    if raw is None or (isinstance(raw, str) and not str(raw).strip()):
        return [0, 1]
    if isinstance(raw, str):
        vals = []
        for p in raw.split(","):
            p = p.strip().lower()
            if p in ("1", "true", "t", "yes", "y"):
                vals.append(1)
            elif p in ("0", "false", "f", "no", "n"):
                vals.append(0)
            else:
                vals.append(1 if int(float(p)) else 0)
        return sorted(set(vals)) or [0]
    return sorted({1 if int(x) else 0 for x in raw}) or [0]


def _parse_cost_pcts(raw: str | Iterable[float] | None, fallback: float) -> list[float]:
    """Parse slip/fee grid as percent-of-price values; 0 = off, else clamp to [0.001, 5]."""
    if raw is None or (isinstance(raw, str) and not str(raw).strip()):
        vals = [float(fallback)]
    else:
        vals = _parse_floats(raw)
    out: list[float] = []
    for v in vals:
        if v <= 0:
            out.append(0.0)
        else:
            out.append(min(5.0, max(0.001, float(v))))
    return out or [0.0]


def _parse_time_window(raw: str | None) -> tuple[int, int] | None:
    """Parse 'HH:MM-HH:MM', 'HH:MM HH:MM', or '330-1260' (IST minutes) → (after, before)."""
    if not raw or not str(raw).strip():
        return None
    s = str(raw).strip().replace("–", "-").replace("—", "-")
    if "-" in s:
        a, b = [x.strip() for x in s.split("-", 1)]
    elif " " in s:
        parts = [x for x in s.split() if x]
        if len(parts) != 2:
            raise ValueError("timewindow must look like 09:30-21:00 or 09:30 21:00")
        a, b = parts[0], parts[1]
    else:
        raise ValueError("timewindow must look like 09:30-21:00 or 330-1260")

    def to_min(x: str) -> int:
        if ":" in x:
            hh, mm = x.split(":", 1)
            return int(hh) * 60 + int(mm)
        return int(x)

    after, before = to_min(a), to_min(b)
    if not (0 <= after < before <= 24 * 60):
        raise ValueError("timewindow range invalid")
    return after, before


def _parse_dow(raw: str | None) -> set[int] | None:
    """Parse 'mon,tue,wed' or '0,1,2,3,4' → set of weekday ints (Mon=0)."""
    if not raw or not str(raw).strip():
        return None
    out: set[int] = set()
    for part in str(raw).split(","):
        key = part.strip().lower()
        if not key:
            continue
        if key not in _DOW:
            raise ValueError(f"Unknown dayofweek token: {part}")
        out.add(_DOW[key])
    return out or None


def _minute_range(start: int, end: int, step: int) -> list[int]:
    step = int(step)
    if step not in ALLOWED_TIME_STEPS:
        raise ValueError("time_step_minutes must be 30 or 60 (15-minute steps are disabled)")
    if end < start:
        start, end = end, start
    out = list(range(int(start), int(end) + 1, step))
    if not out or out[-1] != end:
        # snap end down to step grid rather than injecting off-grid 15m points
        last = int(start) + ((int(end) - int(start)) // step) * step
        if last not in out:
            out.append(last)
    seen: set[int] = set()
    uniq: list[int] = []
    for m in out:
        if m not in seen:
            seen.add(m)
            uniq.append(m)
    return uniq


def _entry_hour_hist(trades: list[Any]) -> dict[str, int]:
    hist = {str(h): 0 for h in range(24)}
    for t in trades:
        et = getattr(t, "entry_time", None)
        if et is None:
            continue
        hour = int(et.hour)
        hist[str(hour)] = hist.get(str(hour), 0) + 1
    return hist


def build_time_sessions(
    *,
    common_optimizer: bool,
    time_optimizer: bool,
    time_step_minutes: int,
    timewindow: str | None,
    entry_after: int,
    entry_before: int,
    exit_time: int,
    entry_after_to: int | None = None,
    entry_before_to: int | None = None,
    exit_time_to: int | None = None,
) -> list[tuple[int, int, int]]:
    """
    Return list of (entry_after, entry_before, exit_time) sessions to test.
    When time_optimizer + step: grid search within from→to ranges.
    """
    if common_optimizer and time_optimizer and time_step_minutes > 0:
        a0 = int(entry_after)
        a1 = int(entry_after_to if entry_after_to is not None else entry_after)
        b0 = int(entry_before)
        b1 = int(entry_before_to if entry_before_to is not None else entry_before)
        e0 = int(exit_time)
        e1 = int(exit_time_to if exit_time_to is not None else exit_time)
        sessions: list[tuple[int, int, int]] = []
        for ea in _minute_range(a0, a1, time_step_minutes):
            for eb in _minute_range(b0, b1, time_step_minutes):
                if ea >= eb:
                    continue
                for et in _minute_range(e0, e1, time_step_minutes):
                    if et < eb:
                        continue
                    sessions.append((ea, eb, et))
        if not sessions:
            raise ValueError(
                "Time optimizer produced no valid sessions. "
                "Need Entry after < Entry before ≤ Exit/Flat, with your step."
            )
        return sessions

    # Single session — After / Before / Flat (timewindow is legacy; ignored)
    ea, eb, et = int(entry_after), int(entry_before), int(exit_time)
    if not (0 <= ea < eb <= 24 * 60) or not (0 <= et <= 24 * 60):
        raise ValueError("Entry/Before/Flat times invalid")
    if et < eb:
        raise ValueError("Flat must be ≥ Before (entry window end)")
    return [(ea, eb, et)]


def apply_common_filters(
    bars: pd.DataFrame,
    *,
    common_optimizer: bool,
    timewindow: str | None,
    dayofweek: str | None,
) -> pd.DataFrame:
    if not common_optimizer:
        return bars
    df = bars.copy()
    df["open_time"] = pd.to_datetime(df["open_time"], utc=True)
    tw = _parse_time_window(timewindow)
    dows = _parse_dow(dayofweek)
    if tw is not None:
        after, before = tw
        mins = df["open_time"].dt.tz_convert(IST).apply(lambda t: t.hour * 60 + t.minute)
        df = df[(mins >= after) & (mins < before)]
    if dows is not None:
        wd = df["open_time"].dt.tz_convert(IST).dt.weekday
        df = df[wd.isin(dows)]
    return df


def _equity_spark_from_trades(
    trades_lite: list[dict[str, Any]] | None,
    *,
    max_points: int = 40,
) -> list[float]:
    """Compact cumulative-PnL series for mini equity charts in the optimize table."""
    if not trades_lite:
        return []
    eq = 0.0
    series: list[float] = []
    for t in trades_lite:
        eq += float(t.get("pnl") or 0.0)
        series.append(eq)
    n = len(series)
    if n <= max_points:
        return series
    out: list[float] = []
    last = max_points - 1
    for i in range(max_points):
        idx = int(round(i * (n - 1) / last))
        out.append(series[idx])
    return out


def _public_row(r: dict[str, Any]) -> dict[str, Any]:
    """JSON-safe combo row for live leaderboard (no full trade blotter)."""
    out = {k: v for k, v in r.items() if k != "_trades_lite"}
    lite = r.get("_trades_lite") or []
    if "equity_spark" not in out:
        out["equity_spark"] = _equity_spark_from_trades(lite)
    return out


def _finalize(
    results: list[dict[str, Any]],
    *,
    symbol: str,
    tf_minutes: int,
    volume: float,
    rank_by: str,
    common_optimizer: bool,
    time_optimizer: bool,
    time_step_minutes: int,
    timewindow: str | None,
    dayofweek: str | None,
    bars_used: int,
    truncated: bool,
    min_trades: int,
    time_stop_minutes: float,
    workers: int = 1,
) -> dict[str, Any]:
    key = rank_by if results and rank_by in results[0] else "net_pnl"
    reverse = key != "max_drawdown"
    floor = max(0, int(min_trades))
    eligible = [r for r in results if int(r.get("trades") or 0) >= floor] if floor > 0 else list(results)
    pool = eligible if eligible else list(results)
    ranked = sorted(
        pool,
        key=lambda p: (p.get(key, 0), p.get("net_pnl", 0), p.get("profit_factor", 0)),
        reverse=reverse,
    )
    # Append rejected (below min trades) after eligible so UI can still inspect them
    if eligible and len(eligible) < len(results):
        rejected = [r for r in results if r not in eligible]
        rejected_sorted = sorted(
            rejected,
            key=lambda p: (p.get(key, 0), p.get("net_pnl", 0)),
            reverse=reverse,
        )
        ranked = ranked + rejected_sorted
    best = ranked[0] if ranked else None
    heatmap = (best or {}).get("entry_hours") if best else None
    best_trades = None
    if best is not None:
        best_trades = best.get("_trades_lite")
    for r in ranked:
        lite = r.pop("_trades_lite", None) or []
        r["equity_spark"] = _equity_spark_from_trades(lite)
        # Keep lite trades for per-row CSV detail exports (small grids)
        r["trades_lite"] = lite
    return {
        "symbol": symbol,
        "tf_minutes": tf_minutes,
        "volume": volume,
        "rank_by": key,
        "common_optimizer": common_optimizer,
        "time_optimizer": bool(time_optimizer and common_optimizer),
        "time_step_minutes": int(time_step_minutes) if time_optimizer and common_optimizer else None,
        "timewindow": timewindow if common_optimizer else None,
        "dayofweek": dayofweek if common_optimizer else None,
        "min_trades": floor,
        "min_trades_eligible": len(eligible),
        "time_stop_minutes": float(time_stop_minutes or 0),
        "workers": int(workers),
        "entry_after": best.get("entry_after") if best else None,
        "entry_before": best.get("entry_before") if best else None,
        "exit_time": best.get("exit_time") if best else None,
        "bars_used": bars_used,
        "runs": len(results),
        "truncated": truncated,
        "slippage_pct": best.get("slippage_pct") if best else None,
        "fee_pct": best.get("fee_pct") if best else None,
        "entry_hour_heatmap": heatmap,
        "best_trades": best_trades,
        "best": best,
        "results": ranked,
        "metric_columns": list(_METRIC_COLUMNS),
    }


def _resolve_workers(requested: int | None, total: int) -> int:
    """Auto = min(CPU-1, 4, total). Cap default to limit RAM with large tick books."""
    cpu = os.cpu_count() or 2
    if requested is None or int(requested) <= 0:
        n = max(1, min(cpu - 1 if cpu > 1 else 1, 4))
    else:
        n = max(1, int(requested))
    return max(1, min(n, total, cpu))


def _load_htf_bars(
    symbol: str,
    exec_tf: int,
    exec_bars: pd.DataFrame,
    base_tfs: Iterable[int],
) -> dict[int, pd.DataFrame]:
    """Load HTF bars for Pro-MTF combos, scoped around the exec window."""
    from backend.engine.bars import ensure_bars_cover

    needed = sorted({int(x) for x in base_tfs if int(x) > int(exec_tf)})
    if not needed:
        return {}
    if exec_bars is None or getattr(exec_bars, "empty", True):
        return {}
    ot = pd.to_datetime(exec_bars["open_time"], utc=True)
    t0 = ot.min() - pd.Timedelta(days=2)
    t1 = ot.max() + pd.Timedelta(minutes=max(needed))
    start = t0.tz_convert(IST).strftime("%Y-%m-%d")
    end = (t1.tz_convert(IST) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    out: dict[int, pd.DataFrame] = {}
    for btf in needed:
        df = ensure_bars_cover(symbol, btf, start, end).copy()
        df["open_time"] = pd.to_datetime(df["open_time"], utc=True)
        scoped = df[(df["open_time"] >= t0) & (df["open_time"] <= t1)]
        if scoped.empty:
            raise ValueError(
                f"Pro-MTF needs {btf}m bars for {symbol} in the selected range. Load that TF first."
            )
        out[btf] = scoped
    return out


def _worker_init(bars_path: str, ticks_path: str, common: dict[str, Any]) -> None:
    global _W_BARS, _W_TICKS, _W_COMMON, _W_BASE
    _W_BARS = pd.read_parquet(bars_path)
    _W_TICKS = pd.read_parquet(ticks_path)
    _W_COMMON = common
    _W_BASE = {}
    for k, p in (common.get("base_bar_paths") or {}).items():
        _W_BASE[int(k)] = pd.read_parquet(p)


def _worker_eval(job: dict[str, Any]) -> dict[str, Any]:
    """Evaluate one grid combo inside a worker process."""
    assert _W_BARS is not None and _W_TICKS is not None and _W_COMMON is not None
    c = _W_COMMON
    mtf = bool(job.get("pro_mtf_mode"))
    wt = False if mtf else bool(job["wait_and_trade"])
    pro = False if mtf else bool(job.get("pro_mode"))
    be = int(job["break_even"] or 0)
    base_tf = int(job.get("base_tf") or 0)
    base_thr = float(job.get("base_threshold") or 0)
    base_bars = None
    if mtf:
        base_map = _W_BASE or {}
        base_bars = base_map.get(base_tf)
    result = run_backtest(
        _W_BARS,
        symbol=str(c["symbol"]),
        tf_minutes=int(c["tf_minutes"]),
        wait_and_trade=wt,
        rr=float(job["rr"]),
        volume=float(job["volume"] if job.get("volume") is not None else c["volume"]),
        threshold=float(job["threshold"]),
        entry_after=int(job["entry_after"]),
        entry_before=int(job["entry_before"]),
        exit_time=int(job["exit_time"]),
        trade_mode=int(c["trade_mode"]),
        slippage_pct=float(job["slippage_pct"]),
        fee_pct=float(job["fee_pct"]),
        time_stop_minutes=float(c["time_stop_minutes"]),
        re_entry=int(job["re_entry"]) if wt else 0,
        stop_to_be=int(job["stop_to_be"]),
        break_even=be,
        break_even_pct=float(job["break_even_pct"]),
        pro_mode=pro,
        pro_vwap_sigma=float(job.get("pro_vwap_sigma") or c.get("pro_vwap_sigma") or 2),
        ticks=_W_TICKS,
        sl_tp_unit=str(job.get("sl_tp_unit") or c.get("sl_tp_unit") or "range"),
        stop_loss=float(job.get("stop_loss") if job.get("stop_loss") is not None else 50),
        take_profit=float(job.get("take_profit") if job.get("take_profit") is not None else 100),
        trail_stop=1 if int(job.get("trail_stop") or 0) else 0,
        risk_on=1 if int(job.get("risk_on") if job.get("risk_on") is not None else 1) else 0,
        sl_on=job.get("sl_on"),
        tp_on=job.get("tp_on"),
        sl_unit=job.get("sl_unit"),
        tp_unit=job.get("tp_unit"),
        trail_unit=str(job.get("trail_unit") or "range"),
        trail_value=float(job.get("trail_value") if job.get("trail_value") is not None else 0),
        be_unit=str(job.get("be_unit") or "range"),
        be_value=float(job.get("be_value") if job.get("be_value") is not None else 0),
        be_ctc=float(job.get("be_ctc") if job.get("be_ctc") is not None else 2),
        pro_mtf_mode=mtf,
        base_tf_minutes=base_tf or 15,
        base_threshold=base_thr or 30.0,
        base_bars=base_bars,
    )
    m = compute_trade_metrics(
        result.trades,
        result.equity,
        bars_count=len(result.bars),
        tf_minutes=int(c["tf_minutes"]),
    )
    return {
        "threshold": float(job["threshold"]),
        "rr": float(job["rr"]),
        "wait_and_trade": wt,
        "pro_mode": int(pro),
        "pro_mtf_mode": int(mtf),
        "base_tf": int(base_tf) if mtf else 0,
        "base_threshold": float(base_thr) if mtf else 0.0,
        "pro_vwap_sigma": float(job.get("pro_vwap_sigma") or 0) if pro else 0.0,
        "re_entry": int(job["re_entry"]) if wt else 0,
        "stop_to_be": int(job["stop_to_be"]),
        "break_even": be,
        "break_even_pct": float(job["break_even_pct"]) if be else 0.0,
        "sl_tp_unit": str(job.get("sl_tp_unit") or "range"),
        "sl_on": 1 if int(job.get("sl_on") if job.get("sl_on") is not None else job.get("risk_on") or 1) else 0,
        "tp_on": 1 if int(job.get("tp_on") if job.get("tp_on") is not None else job.get("risk_on") or 1) else 0,
        "sl_unit": str(job.get("sl_unit") or job.get("sl_tp_unit") or "range"),
        "tp_unit": str(job.get("tp_unit") or job.get("sl_tp_unit") or "range"),
        "stop_loss": float(job.get("stop_loss") or 0),
        "take_profit": float(job.get("take_profit") or 0),
        "trail_stop": 1 if int(job.get("trail_stop") or 0) else 0,
        "risk_on": 1 if int(job.get("risk_on") if job.get("risk_on") is not None else 1) else 0,
        "trail_unit": str(job.get("trail_unit") or "range"),
        "trail_value": float(job.get("trail_value") if job.get("trail_value") is not None else 0),
        "be_unit": str(job.get("be_unit") or "range"),
        "be_value": float(job.get("be_value") if job.get("be_value") is not None else 0),
        "be_ctc": float(job.get("be_ctc") if job.get("be_ctc") is not None else 2),
        "volume": float(job["volume"] if job.get("volume") is not None else c["volume"]),
        "entry_after": int(job["entry_after"]),
        "entry_before": int(job["entry_before"]),
        "exit_time": int(job["exit_time"]),
        "time_stop_minutes": float(c["time_stop_minutes"]),
        "total_slippage": float(result.stats.get("total_slippage") or 0),
        "total_fees": float(result.stats.get("total_fees") or 0),
        "total_cost": float(
            result.stats.get("total_cost")
            if result.stats.get("total_cost") is not None
            else (
                float(result.stats.get("total_slippage") or 0)
                + float(result.stats.get("total_fees") or 0)
            )
        ),
        "gross_pnl": float(
            result.stats.get("gross_pnl")
            if result.stats.get("gross_pnl") is not None
            else (float(result.stats.get("net_pnl") or 0) + float(result.stats.get("total_fees") or 0))
        ),
        "slippage_pct": float(job["slippage_pct"]),
        "fee_pct": float(job["fee_pct"]),
        "entry_hours": _entry_hour_hist(result.trades),
        "entry_tags": dict(result.stats.get("entry_tags") or {}),
        "_trades_lite": [
            {
                "side": t.side,
                "signal_time": t.signal_time.isoformat(),
                "entry_time": t.entry_time.isoformat(),
                "exit_time": t.exit_time.isoformat(),
                "entry_price": float(t.entry_price),
                "exit_price": float(t.exit_price),
                "stop": float(t.stop),
                "target": float(t.target),
                "pnl": float(t.pnl),
                "mfe": float(t.mfe),
                "mae": float(t.mae),
                "slippage": float(t.slippage),
                "fee": float(t.fee),
                "entry_tag": t.entry_tag,
                "exit_reason": t.exit_reason,
                "be_moved": bool(t.be_moved),
                "signal_delta_pct": float(t.signal_delta_pct),
                "range": float(t.range),
            }
            for t in result.trades
        ],
        **m,
        "exits": dict(result.stats.get("exits") or {}),
    }


def _eval_combo_local(
    *,
    bars: pd.DataFrame,
    ticks: pd.DataFrame,
    symbol: str,
    tf_minutes: int,
    volume: float,
    trade_mode: int,
    tstop: float,
    job: dict[str, Any],
    pro_vwap_sigma: float = 2.0,
    base_by_tf: dict[int, pd.DataFrame] | None = None,
) -> dict[str, Any]:
    """Sequential path (same shape as worker result)."""
    global _W_BARS, _W_TICKS, _W_COMMON, _W_BASE
    _W_BARS = bars
    _W_TICKS = ticks
    _W_BASE = base_by_tf or {}
    _W_COMMON = {
        "symbol": symbol,
        "tf_minutes": tf_minutes,
        "volume": volume,
        "trade_mode": trade_mode,
        "time_stop_minutes": tstop,
        "pro_vwap_sigma": float(pro_vwap_sigma),
    }
    try:
        return _worker_eval(job)
    finally:
        _W_BARS = _W_TICKS = _W_COMMON = _W_BASE = None


def _iter_grid(
    bars: pd.DataFrame,
    *,
    symbol: str = "ETHUSDT",
    tf_minutes: int = 15,
    volume: float = 0.01,
    volumes: str | list[float] | None = None,
    thresholds: str | list[float] = "40,50,60",
    rrs: str | list[float] = "0.5,1,1.5,2",
    wait_flags: str | list[bool] = "false,true",
    max_runs: int = 400,
    rank_by: str = "sharpe",
    common_optimizer: bool = False,
    time_optimizer: bool = False,
    time_step_minutes: int = 30,
    timewindow: str | None = "",
    dayofweek: str | None = "mon,tue,wed,thu,fri,sat,sun",
    entry_after: int = 330,
    entry_before: int = 1260,
    exit_time: int = 1260,
    entry_after_to: int | None = None,
    entry_before_to: int | None = None,
    exit_time_to: int | None = None,
    trade_mode: int = 2,
    slippage_pct: float = 0.0,
    fee_pct: float = 0.0,
    slippage_pcts: str | list[float] | None = None,
    fee_pcts: str | list[float] | None = None,
    min_trades: int = 0,
    time_stop_minutes: float = 0.0,
    pro_vwap_sigma: float = 2.0,
    pro_vwap_sigmas: str | list[float] | None = None,
    re_entry_flags: str | list[int] | None = "0,1",
    stop_to_be_flags: str | list[int] | None = "0,1",
    break_even_flags: str | list[int] | None = "0,1",
    break_even_pcts: str | list[float] | None = "50",
    sl_tp_unit: str = "range",
    sl_unit: str | None = None,
    tp_unit: str | None = None,
    stop_losses: str | list[float] | None = "50",
    take_profits: str | list[float] | None = "100",
    trail_stop_flags: str | list[int] | None = "0",
    risk_on_flags: str | list[int] | None = "1",
    sl_on_flags: str | list[int] | None = None,
    tp_on_flags: str | list[int] | None = None,
    trail_unit: str = "range",
    trail_value: float = 0.0,
    trail_values: str | list[float] | None = None,
    be_unit: str = "range",
    be_value: float = 0.0,
    be_values: str | list[float] | None = None,
    be_ctc: float = 2.0,
    workers: int | None = 0,
    ticks: pd.DataFrame | None = None,
    base_tfs: str | list[float] | None = None,
    base_thresholds: str | list[float] | None = None,
) -> Iterator[dict[str, Any]]:
    from backend.engine.volume_delta import _normalize_sl_tp_unit

    th_list = _parse_floats(thresholds)
    strat_list = _parse_strategy_flags(wait_flags)
    re_list = _parse_re_entry_flags(re_entry_flags)
    stobe_list = _parse_re_entry_flags(stop_to_be_flags)
    be_list = _parse_re_entry_flags(break_even_flags)
    # BreakEven lock is derived from be_unit / be_value (no BE% grid axis)
    be_pct_list = [50.0]
    slip_list = _parse_cost_pcts(slippage_pcts, slippage_pct)
    fee_list = _parse_cost_pcts(fee_pcts, fee_pct)
    sl_u = _normalize_sl_tp_unit(sl_unit or sl_tp_unit)
    tp_u = _normalize_sl_tp_unit(tp_unit or sl_tp_unit)
    trail_list = _parse_re_entry_flags(trail_stop_flags if trail_stop_flags is not None else "0")
    risk_fallback = _parse_re_entry_flags(risk_on_flags if risk_on_flags is not None else "1") or [1]
    sl_on_list = _parse_re_entry_flags(sl_on_flags if sl_on_flags is not None else risk_fallback) or [1]
    tp_on_list = _parse_re_entry_flags(tp_on_flags if tp_on_flags is not None else risk_fallback) or [1]
    trail_u = _normalize_sl_tp_unit(trail_unit)
    trail_v = float(trail_value if trail_value is not None else 0.0)
    be_u = _normalize_sl_tp_unit(be_unit)
    be_v = float(be_value if be_value is not None else 0.0)
    be_c = max(0.0, float(be_ctc if be_ctc is not None else 2.0))
    sweep_trail = trail_u != "range" and any(int(x) for x in trail_list)
    raw_tv = _parse_floats(trail_values) if trail_values not in (None, "") else []
    trail_val_list = [max(0.0, float(v)) for v in raw_tv] or [max(0.0, trail_v)]
    sweep_be_dist = be_u in ("tick", "points") and any(int(x) for x in be_list)
    raw_bv = _parse_floats(be_values) if be_values not in (None, "") else []
    be_val_list = [float(v) for v in raw_bv] or [be_v]
    vol_raw = _parse_floats(volumes) if volumes not in (None, "") else []
    vol_list = [max(1e-8, float(v)) for v in vol_raw] or [max(1e-8, float(volume or 0.01))]
    sweep_sl = sl_u != "range" and any(int(x) for x in sl_on_list)
    sweep_tp = tp_u != "range" and any(int(x) for x in tp_on_list)
    sweep_rr = tp_u == "range" and any(int(x) for x in tp_on_list)
    rr_list = _parse_floats(rrs) if sweep_rr else [1.0]
    sl_list = (
        (_parse_floats(stop_losses if stop_losses not in (None, "") else "50") or [50.0])
        if sweep_sl
        else [50.0]
    )
    tp_list = (
        (_parse_floats(take_profits if take_profits not in (None, "") else "100") or [100.0])
        if sweep_tp
        else [100.0]
    )
    if not th_list or not rr_list or not strat_list:
        raise ValueError("thresholds, rrs/SL-TP, and wait_flags must be non-empty")
    if time_optimizer and common_optimizer and int(time_step_minutes) not in ALLOWED_TIME_STEPS:
        raise ValueError("time_step_minutes must be 30 or 60")

    filtered = apply_common_filters(
        bars,
        common_optimizer=common_optimizer,
        timewindow=timewindow,
        dayofweek=dayofweek,
    )
    if filtered.empty:
        raise ValueError(
            "No bars left after common optimizer filters (timewindow / dayofweek). "
            "Select more weekdays, widen the time window, or turn Common optimizer off."
        )

    sessions = build_time_sessions(
        common_optimizer=common_optimizer,
        time_optimizer=time_optimizer,
        time_step_minutes=time_step_minutes,
        timewindow=timewindow,
        entry_after=entry_after,
        entry_before=entry_before,
        exit_time=exit_time,
        entry_after_to=entry_after_to,
        entry_before_to=entry_before_to,
        exit_time_to=exit_time_to,
    )

    if ticks is None:
        from backend.engine.bars import load_ticks

        start = end = None
        if not filtered.empty:
            ot = pd.to_datetime(filtered["open_time"], utc=True)
            start = ot.iloc[0].tz_convert(IST).strftime("%Y-%m-%d")
            end = (ot.iloc[-1].tz_convert(IST) + pd.Timedelta(days=2)).strftime("%Y-%m-%d")
        ticks = load_ticks(symbol, start=start, end=end)

    # Precompute indicators on full bars; slice ticks to widest session window
    filtered = attach_session_indicators(filtered)
    buf = max(5, int(tf_minutes))
    eas = [int(s[0]) for s in sessions]
    ebs = [int(s[1]) for s in sessions]
    ets = [int(s[2]) for s in sessions]
    ticks = slice_ticks_to_session(
        ticks,
        min(eas),
        max(ebs),
        max(ets),
        buffer_min=buf,
    )

    # re_entry only when WaitAndTrade=true (ORB); Wait=false / Pro / Pro-MTF forces 0
    # BreakEven is available in all modes (independent of Risk)
    # Lock is CTC × (entry slip USDT + entry fee USDT) / lots after the arm
    # Pro-MTF extra axes: Base TF / Base Thr%
    wants_mtf = any(mtf for _, _, mtf in strat_list)
    sigma_list = _parse_sigmas(pro_vwap_sigmas, float(pro_vwap_sigma or 2))
    base_tf_list = [
        int(x) for x in (_parse_floats(base_tfs) if base_tfs not in (None, "") else [])
        if int(x) > int(tf_minutes)
    ]
    base_thr_list = (
        _parse_floats(base_thresholds) if base_thresholds not in (None, "") else [30.0]
    ) or [30.0]
    if wants_mtf and not base_tf_list:
        for cand in (15, 30, 60, 120, 240):
            if cand > int(tf_minutes):
                base_tf_list = [cand]
                break
        if not base_tf_list:
            raise ValueError(
                f"Pro-MTF Base TF must be greater than chart TF ({tf_minutes}m)."
            )

    combos: list[tuple] = []

    def _append(
        th: float,
        rr: float,
        sl: float,
        tp: float,
        wt: bool,
        pro: bool,
        mtf: bool,
        slip: float,
        fee: float,
        trail: int,
        sess: tuple,
        re: int,
        stobe: int,
        be: int,
        be_pct: float,
        vol: float,
        sl_flag: int,
        tp_flag: int,
        trail_v: float,
        be_v: float,
    ) -> None:
        btf_iter: Iterable[int] = base_tf_list if mtf else (0,)
        bthr_iter: Iterable[float] = base_thr_list if mtf else (0.0,)
        for btf in btf_iter:
            if mtf and int(btf) <= int(tf_minutes):
                continue
            for bthr in bthr_iter:
                sig_iter: Iterable[float] = sigma_list if pro else (2.0,)
                for sig in sig_iter:
                    combos.append(
                        (
                            th, rr, sl, tp, wt, pro, mtf, slip, fee, trail, sess,
                            re, stobe, be, be_pct, int(btf), float(bthr), float(sig),
                            float(vol), int(sl_flag), int(tp_flag),
                            float(trail_v), float(be_v),
                        )
                    )

    for th, (wt, pro, mtf), slip, fee, trail, vol, sess in product(
        th_list, strat_list, slip_list, fee_list, trail_list, vol_list, sessions
    ):
        for re in re_list if wt else (0,):
            for stobe in stobe_list:
                for be in be_list:
                    pct_iter = be_pct_list if be else (be_pct_list[0],)
                    for be_pct in pct_iter:
                        for sl_flag in sl_on_list:
                            sls = sl_list if (int(sl_flag) and sweep_sl) else (sl_list[0],)
                            for sl in sls:
                                for tp_flag in tp_on_list:
                                    tps = tp_list if (int(tp_flag) and sweep_tp) else (tp_list[0],)
                                    rrs_iter = rr_list if (int(tp_flag) and sweep_rr) else (rr_list[0],)
                                    for tp in tps:
                                        for rr in rrs_iter:
                                            tvs = (
                                                trail_val_list
                                                if (int(trail) and sweep_trail)
                                                else (trail_val_list[0],)
                                            )
                                            bvs = (
                                                be_val_list
                                                if (int(be) and sweep_be_dist)
                                                else (be_val_list[0],)
                                            )
                                            for tv in tvs:
                                                for bv in bvs:
                                                    _append(
                                                        th, rr, sl, tp, wt, pro, mtf, slip, fee, trail,
                                                        sess, re, stobe, be, be_pct, vol, sl_flag, tp_flag,
                                                        tv, bv,
                                                    )
    if wants_mtf and not any(c[6] for c in combos):
        raise ValueError(
            f"Pro-MTF produced no combos — Base TF must be > chart TF ({tf_minutes}m)."
        )
    truncated = len(combos) > max_runs
    if truncated:
        combos = combos[:max_runs]
    total = len(combos)
    n_workers = _resolve_workers(workers, total)
    yield {"type": "progress", "done": 0, "total": total, "workers": n_workers}

    tstop = float(time_stop_minutes or 0.0)
    sigma_n = float(pro_vwap_sigma) if float(pro_vwap_sigma or 0) > 0 else 2.0
    if sigma_n not in (1.0, 2.0, 3.0):
        sigma_n = min((1.0, 2.0, 3.0), key=lambda x: abs(x - sigma_n))
    jobs: list[dict[str, Any]] = []
    for th, rr, sl, tp, wt, pro, mtf, slip, fee, trail, sess, re, stobe, be, be_pct, btf, bthr, sig, vol, sl_flag, tp_flag, tv, bv in combos:
        ea, eb, et = sess
        jobs.append(
            {
                "threshold": float(th),
                "rr": float(rr),
                "wait_and_trade": bool(wt),
                "pro_mode": bool(pro),
                "pro_mtf_mode": bool(mtf),
                "base_tf": int(btf),
                "base_threshold": float(bthr),
                "pro_vwap_sigma": float(sig) if pro else 2.0,
                "slippage_pct": float(slip),
                "fee_pct": float(fee),
                "volume": float(vol),
                "entry_after": int(ea),
                "entry_before": int(eb),
                "exit_time": int(et),
                "re_entry": int(re),
                "stop_to_be": int(stobe),
                "break_even": int(be),
                "break_even_pct": float(be_pct),
                "sl_tp_unit": sl_u if sl_u == tp_u else f"{sl_u}/{tp_u}",
                "stop_loss": float(sl),
                "take_profit": float(tp),
                "trail_stop": 1 if int(trail) else 0,
                "risk_on": 1 if (int(sl_flag) or int(tp_flag)) else 0,
                "sl_on": 1 if int(sl_flag) else 0,
                "tp_on": 1 if int(tp_flag) else 0,
                "sl_unit": sl_u,
                "tp_unit": tp_u,
                "trail_unit": trail_u,
                "trail_value": float(tv),
                "be_unit": be_u,
                "be_value": float(bv),
                "be_ctc": be_c,
            }
        )

    mtf_tfs = sorted({int(j["base_tf"]) for j in jobs if j.get("pro_mtf_mode")})
    base_by_tf = _load_htf_bars(symbol, int(tf_minutes), filtered, mtf_tfs) if mtf_tfs else {}

    results: list[dict[str, Any]] = []
    tmp_dir: str | None = None
    executor: ProcessPoolExecutor | None = None
    try:
        if n_workers <= 1 or total <= 1:
            for i, job in enumerate(jobs, start=1):
                row = _eval_combo_local(
                    bars=filtered,
                    ticks=ticks,
                    symbol=symbol,
                    tf_minutes=tf_minutes,
                    volume=volume,
                    trade_mode=trade_mode,
                    tstop=tstop,
                    job=job,
                    pro_vwap_sigma=sigma_n,
                    base_by_tf=base_by_tf,
                )
                results.append(row)
                yield {
                    "type": "combo",
                    "done": i,
                    "total": total,
                    "workers": n_workers,
                    "row": _public_row(row),
                }
        else:
            tmp_dir = tempfile.mkdtemp(prefix="opt_")
            bars_path = str(Path(tmp_dir) / "bars.parquet")
            ticks_path = str(Path(tmp_dir) / "ticks.parquet")
            filtered.to_parquet(bars_path, index=False)
            ticks.to_parquet(ticks_path, index=False)
            base_bar_paths: dict[str, str] = {}
            for btf, df in base_by_tf.items():
                p = str(Path(tmp_dir) / f"base_{int(btf)}.parquet")
                df.to_parquet(p, index=False)
                base_bar_paths[str(int(btf))] = p
            common = {
                "symbol": symbol,
                "tf_minutes": int(tf_minutes),
                "volume": float(volume),
                "trade_mode": int(trade_mode),
                "time_stop_minutes": tstop,
                "pro_vwap_sigma": sigma_n,
                "base_bar_paths": base_bar_paths,
            }
            executor = ProcessPoolExecutor(
                max_workers=n_workers,
                initializer=_worker_init,
                initargs=(bars_path, ticks_path, common),
            )
            futs = [executor.submit(_worker_eval, job) for job in jobs]
            done = 0
            for fut in as_completed(futs):
                row = fut.result()
                results.append(row)
                done += 1
                yield {
                    "type": "combo",
                    "done": done,
                    "total": total,
                    "workers": n_workers,
                    "row": _public_row(row),
                }
    finally:
        if executor is not None:
            try:
                executor.shutdown(wait=False, cancel_futures=True)
            except TypeError:
                executor.shutdown(wait=False)
        if tmp_dir is not None:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    payload = _finalize(
        results,
        symbol=symbol,
        tf_minutes=tf_minutes,
        volume=volume,
        rank_by=rank_by,
        common_optimizer=common_optimizer,
        time_optimizer=time_optimizer,
        time_step_minutes=time_step_minutes,
        timewindow=timewindow,
        dayofweek=dayofweek,
        bars_used=int(len(filtered)),
        truncated=truncated,
        min_trades=min_trades,
        time_stop_minutes=tstop,
        workers=n_workers,
    )
    yield {"type": "result", "payload": payload}


def run_optimize(bars: pd.DataFrame, **kwargs: Any) -> dict[str, Any]:
    cb: ProgressCb | None = kwargs.pop("on_progress", None)
    payload: dict[str, Any] | None = None
    for ev in _iter_grid(bars, **kwargs):
        if ev.get("type") == "result":
            payload = ev["payload"]
        if ev.get("type") == "progress" and cb is not None:
            cb(int(ev["done"]), int(ev["total"]))
    if payload is None:
        raise RuntimeError("Optimize produced no result")
    return payload


def iter_optimize_progress(bars: pd.DataFrame, **kwargs: Any) -> Iterator[dict[str, Any]]:
    """Yield NDJSON progress events during the grid, then the final result."""
    kwargs.pop("on_progress", None)
    yield from _iter_grid(bars, **kwargs)


# Back-compat alias used by older imports
def resolve_session_times(
    *,
    common_optimizer: bool,
    time_optimizer: bool,
    timewindow: str | None,
    entry_after: int,
    entry_before: int,
    exit_time: int,
) -> tuple[int, int, int]:
    return build_time_sessions(
        common_optimizer=common_optimizer,
        time_optimizer=time_optimizer,
        time_step_minutes=0,
        timewindow=timewindow,
        entry_after=entry_after,
        entry_before=entry_before,
        exit_time=exit_time,
    )[0]
