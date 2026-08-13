"""Brute-force parameter grid with quant performance metrics + common filters."""
from __future__ import annotations

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
from backend.engine.volume_delta import run_backtest

ProgressCb = Callable[[int, int], None]

IST = ZoneInfo("Asia/Kolkata")

# Intraday time-optimizer steps (no 15m — too noisy / too many combos)
ALLOWED_TIME_STEPS = frozenset({30, 60})

# Per-process state for parallel workers (set by _worker_init)
_W_BARS: pd.DataFrame | None = None
_W_TICKS: pd.DataFrame | None = None
_W_COMMON: dict[str, Any] | None = None

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
    "trades",
]


def _parse_floats(raw: str | Iterable[float]) -> list[float]:
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.split(",") if p.strip()]
        return [float(p) for p in parts]
    return [float(x) for x in raw]


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


def _parse_strategy_flags(raw: str | Iterable[Any]) -> list[tuple[bool, bool]]:
    """
    Parse strategy grid into (wait_and_trade, pro_mode) pairs.
    Accepts: false/true/pro (and aliases).
    """
    if not isinstance(raw, str):
        return [(bool(x), False) for x in raw]
    out: list[tuple[bool, bool]] = []
    for p in raw.split(","):
        p = p.strip().lower()
        if p in ("pro", "p"):
            out.append((False, True))
        elif p in ("1", "true", "t", "yes", "y", "non_directional", "nd"):
            out.append((True, False))
        elif p in ("0", "false", "f", "no", "n", "directional", "dir"):
            out.append((False, False))
    return out


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
    """Parse slip/fee grid; 0 allowed, else clamp to [0.005, 1]."""
    if raw is None or (isinstance(raw, str) and not str(raw).strip()):
        vals = [float(fallback)]
    else:
        vals = _parse_floats(raw)
    out: list[float] = []
    for v in vals:
        if v <= 0:
            out.append(0.0)
        else:
            out.append(min(1.0, max(0.005, float(v))))
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


def _worker_init(bars_path: str, ticks_path: str, common: dict[str, Any]) -> None:
    global _W_BARS, _W_TICKS, _W_COMMON
    _W_BARS = pd.read_parquet(bars_path)
    _W_TICKS = pd.read_parquet(ticks_path)
    _W_COMMON = common


def _worker_eval(job: dict[str, Any]) -> dict[str, Any]:
    """Evaluate one grid combo inside a worker process."""
    assert _W_BARS is not None and _W_TICKS is not None and _W_COMMON is not None
    c = _W_COMMON
    wt = bool(job["wait_and_trade"])
    pro = bool(job.get("pro_mode"))
    be = int(job["break_even"]) if (not wt or pro) else 0
    if wt:
        be = 0
    result = run_backtest(
        _W_BARS,
        symbol=str(c["symbol"]),
        tf_minutes=int(c["tf_minutes"]),
        wait_and_trade=wt,
        rr=float(job["rr"]),
        volume=float(c["volume"]),
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
        pro_vwap_sigma=float(c.get("pro_vwap_sigma") or 2),
        ticks=_W_TICKS,
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
        "re_entry": int(job["re_entry"]) if wt else 0,
        "stop_to_be": int(job["stop_to_be"]),
        "break_even": be,
        "break_even_pct": float(job["break_even_pct"]) if ((not wt or pro) and be) else 0.0,
        "entry_after": int(job["entry_after"]),
        "entry_before": int(job["entry_before"]),
        "exit_time": int(job["exit_time"]),
        "time_stop_minutes": float(c["time_stop_minutes"]),
        "total_slippage": float(result.stats.get("total_slippage") or 0),
        "total_fees": float(result.stats.get("total_fees") or 0),
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
) -> dict[str, Any]:
    """Sequential path (same shape as worker result)."""
    global _W_BARS, _W_TICKS, _W_COMMON
    _W_BARS = bars
    _W_TICKS = ticks
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
        _W_BARS = _W_TICKS = _W_COMMON = None


def _iter_grid(
    bars: pd.DataFrame,
    *,
    symbol: str = "ETHUSDT",
    tf_minutes: int = 15,
    volume: float = 0.01,
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
    re_entry_flags: str | list[int] | None = "0,1",
    stop_to_be_flags: str | list[int] | None = "0,1",
    break_even_flags: str | list[int] | None = "0,1",
    break_even_pcts: str | list[float] | None = "50",
    workers: int | None = 0,
    ticks: pd.DataFrame | None = None,
) -> Iterator[dict[str, Any]]:
    th_list = _parse_floats(thresholds)
    rr_list = _parse_floats(rrs)
    strat_list = _parse_strategy_flags(wait_flags)
    re_list = _parse_re_entry_flags(re_entry_flags)
    stobe_list = _parse_re_entry_flags(stop_to_be_flags)
    be_list = _parse_re_entry_flags(break_even_flags)
    be_pct_raw = _parse_floats(break_even_pcts) if break_even_pcts not in (None, "") else [50.0]
    be_pct_list = [max(1.0, min(100.0, float(p))) for p in (be_pct_raw or [50.0])]
    slip_list = _parse_cost_pcts(slippage_pcts, slippage_pct)
    fee_list = _parse_cost_pcts(fee_pcts, fee_pct)
    if not th_list or not rr_list or not strat_list:
        raise ValueError("thresholds, rrs, and wait_flags must be non-empty")
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
            start = ot.iloc[0].strftime("%Y-%m-%d")
            end = (ot.iloc[-1] + pd.Timedelta(days=2)).strftime("%Y-%m-%d")
        ticks = load_ticks(symbol, start=start, end=end)

    # re_entry only when WaitAndTrade=true (ORB); Wait=false / Pro forces 0
    # break_even only when Directional or Pro; Non-Dir forces 0
    # BE% only multiplies the grid when BreakEven is on
    combos: list[tuple] = []
    for th, rr, (wt, pro), slip, fee, sess in product(
        th_list, rr_list, strat_list, slip_list, fee_list, sessions
    ):
        for re in re_list if wt else (0,):
            for stobe in stobe_list:
                for be in be_list if not wt else (0,):
                    pct_iter = be_pct_list if be else (be_pct_list[0],)
                    for be_pct in pct_iter:
                        combos.append((th, rr, wt, pro, slip, fee, sess, re, stobe, be, be_pct))
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
    for th, rr, wt, pro, slip, fee, sess, re, stobe, be, be_pct in combos:
        ea, eb, et = sess
        jobs.append(
            {
                "threshold": float(th),
                "rr": float(rr),
                "wait_and_trade": bool(wt),
                "pro_mode": bool(pro),
                "slippage_pct": float(slip),
                "fee_pct": float(fee),
                "entry_after": int(ea),
                "entry_before": int(eb),
                "exit_time": int(et),
                "re_entry": int(re),
                "stop_to_be": int(stobe),
                "break_even": int(be),
                "break_even_pct": float(be_pct),
            }
        )

    results: list[dict[str, Any]] = []
    tmp_dir: str | None = None
    executor: ProcessPoolExecutor | None = None
    try:
        if n_workers <= 1 or total <= 1:
            for i, job in enumerate(jobs, start=1):
                results.append(
                    _eval_combo_local(
                        bars=filtered,
                        ticks=ticks,
                        symbol=symbol,
                        tf_minutes=tf_minutes,
                        volume=volume,
                        trade_mode=trade_mode,
                        tstop=tstop,
                        job=job,
                        pro_vwap_sigma=sigma_n,
                    )
                )
                yield {
                    "type": "progress",
                    "done": i,
                    "total": total,
                    "workers": n_workers,
                }
        else:
            tmp_dir = tempfile.mkdtemp(prefix="opt_")
            bars_path = str(Path(tmp_dir) / "bars.parquet")
            ticks_path = str(Path(tmp_dir) / "ticks.parquet")
            filtered.to_parquet(bars_path, index=False)
            ticks.to_parquet(ticks_path, index=False)
            common = {
                "symbol": symbol,
                "tf_minutes": int(tf_minutes),
                "volume": float(volume),
                "trade_mode": int(trade_mode),
                "time_stop_minutes": tstop,
                "pro_vwap_sigma": sigma_n,
            }
            executor = ProcessPoolExecutor(
                max_workers=n_workers,
                initializer=_worker_init,
                initargs=(bars_path, ticks_path, common),
            )
            futs = [executor.submit(_worker_eval, job) for job in jobs]
            done = 0
            for fut in as_completed(futs):
                results.append(fut.result())
                done += 1
                yield {
                    "type": "progress",
                    "done": done,
                    "total": total,
                    "workers": n_workers,
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
