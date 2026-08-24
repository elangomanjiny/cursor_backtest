from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import json

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.engine.bars import SUPPORTED_TF, load_or_build_bars, load_ticks  # noqa: E402
from backend.engine.dataloader import (  # noqa: E402
    SUPPORTED_EXCHANGES,
    data_availability,
    load_dataset,
)
from backend.engine.formatting import round_obj  # noqa: E402
from backend.engine.nautilus_bridge import status as nautilus_status  # noqa: E402
from backend.engine.optimize import iter_optimize_progress, run_optimize  # noqa: E402
from backend.engine.questdb_client import health as questdb_health  # noqa: E402
from backend.engine.system_resources import get_system_resources  # noqa: E402
from backend.engine.volume_delta import (  # noqa: E402
    ENGINE_ID,
    check_parity_aug1,
    result_to_jsonable,
    run_backtest,
    write_parity_report,
)

APP_VERSION = "2.1.27"
app = FastAPI(title="cursor_backtest", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _scope_bars(
    bars: pd.DataFrame,
    start: str | None = "2026-08-01",
    end: str | None = "2026-08-03",
) -> pd.DataFrame:
    out = bars.copy()
    out["open_time"] = pd.to_datetime(out["open_time"], utc=True)
    if start:
        out = out[out["open_time"] >= pd.Timestamp(start, tz="UTC")]
    if end:
        out = out[out["open_time"] < pd.Timestamp(end, tz="UTC")]
    return out


def _load_bars(symbol: str, tf: int) -> pd.DataFrame:
    try:
        return load_or_build_bars(symbol, tf)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def _ensure_ready(
    exchange: str, symbol: str, start: str, end: str, tf: int
) -> dict:
    """Build bars for TF from ticks if needed, then re-check availability."""
    try:
        load_or_build_bars(symbol, tf)
    except FileNotFoundError:
        pass
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    avail = data_availability(
        exchange=exchange, symbol=symbol, start=start, end=end, tf=tf
    )
    if not avail["ready"]:
        raise HTTPException(
            409,
            {
                "message": "Data not available — complete Step 1–2 first (or load ticks for this symbol/range).",
                "availability": avail,
            },
        )
    return avail


@app.get("/api/system/resources")
def system_resources():
    """RAM / CPU snapshot for the Optimize capacity strip."""
    return get_system_resources()


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "version": APP_VERSION,
        "root": str(ROOT),
        "supported_tf": list(SUPPORTED_TF),
        "supported_exchanges": list(SUPPORTED_EXCHANGES),
        "questdb": questdb_health(),
        "nautilus": nautilus_status(),
    }


@app.get("/api/data/status")
def data_status(
    exchange: str = "BINANCE_UM",
    symbol: str = "ETHUSDT",
    start: str = "2026-08-01",
    end: str = "2026-08-03",
    tf: int = Query(15, alias="tf"),
):
    try:
        return data_availability(
            exchange=exchange, symbol=symbol, start=start, end=end, tf=tf
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/data/load")
def data_load(
    exchange: str = "BINANCE_UM",
    symbol: str = "ETHUSDT",
    start: str = "2026-08-01",
    end: str = "2026-08-03",
    tf: int = Query(15, alias="tf"),
):
    try:
        manifest = load_dataset(
            exchange=exchange, symbol=symbol, start=start, end=end, tf=tf
        )
        status = data_availability(
            exchange=exchange, symbol=symbol, start=start, end=end, tf=tf
        )
        return {"manifest": manifest, "availability": status}
    except (ValueError, FileNotFoundError, RuntimeError) as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Data load failed: {e}") from e


@app.get("/api/data/bars")
def data_bars(
    symbol: str = "ETHUSDT",
    tf: int = Query(15, alias="tf"),
    start: str = "2026-08-01",
    end: str = "2026-08-03",
    limit: int = 500,
):
    """OHLCV + delta table for Data Loader preview."""
    try:
        bars = _load_bars(symbol, tf)
    except HTTPException:
        raise
    scoped = _scope_bars(bars, start, end)
    if scoped.empty:
        return {"symbol": symbol, "tf": tf, "bars": [], "count": 0}
    # newest last; cap rows for UI
    if len(scoped) > limit:
        scoped = scoped.iloc[-limit:]
    rows = []
    for _, r in scoped.iterrows():
        rows.append(
            round_obj(
                {
                    "time": pd.Timestamp(r["open_time"]).isoformat(),
                    "open": float(r["open"]),
                    "high": float(r["high"]),
                    "low": float(r["low"]),
                    "close": float(r["close"]),
                    "volume_quote": float(r.get("volume_quote", 0)),
                    "volume_base": float(r.get("volume_base", 0)),
                    "delta_quote": float(r.get("delta_quote", 0)),
                    "delta_base": float(r.get("delta_base", 0)),
                    "delta_pct": float(r.get("delta_pct", 0)),
                }
            )
        )
    return {"symbol": symbol, "tf": tf, "start": start, "end": end, "count": len(rows), "bars": rows}


@app.get("/api/backtest")
def backtest(
    symbol: str = "ETHUSDT",
    tf: int = Query(15, alias="tf"),
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
    start: str | None = "2026-08-01",
    end: str | None = "2026-08-03",
    exchange: str = "BINANCE_UM",
    # Optional IST weekday filter (same tokens as optimize) for Apply parity.
    dayofweek: str | None = None,
    # Optional CSV of IST entry hours 0-23 (heatmap Apply filter), e.g. "8,9,11,15,20".
    allowed_entry_hours: str | None = None,
    # SL/TP sizing: range (AGGR×RR) | tick | points | pct
    sl_tp_unit: str = "range",
    stop_loss: float = 50.0,
    take_profit: float = 100.0,
    trail_stop: int = 0,
    risk_on: int = 1,
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
    base_tf: int = Query(15, alias="base_tf"),
    base_threshold: float = 30.0,
):
    avail = _ensure_ready(
        exchange, symbol, start or "2026-08-01", end or "2026-08-03", tf
    )

    bars = _load_bars(symbol, tf)
    scoped = _scope_bars(bars, start, end)
    if scoped.empty:
        raise HTTPException(400, "No bars in requested range")

    # Match optimize common day-of-week bar filter when Apply sends dayofweek.
    if dayofweek and str(dayofweek).strip():
        from backend.engine.optimize import apply_common_filters

        scoped = apply_common_filters(
            scoped,
            common_optimizer=True,
            timewindow=None,
            dayofweek=dayofweek,
        )
        if scoped.empty:
            raise HTTPException(400, "No bars left after dayofweek filter")

    base_scoped = None
    if pro_mtf_mode:
        if int(base_tf) <= int(tf):
            raise HTTPException(
                400,
                f"Pro-MTF Base TF ({base_tf}m) must be greater than chart TF ({tf}m).",
            )
        try:
            base_all = _load_bars(symbol, int(base_tf))
        except FileNotFoundError as e:
            raise HTTPException(409, str(e)) from e
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        base_scoped = _scope_bars(base_all, start, end)
        if base_scoped.empty:
            raise HTTPException(400, f"No {base_tf}m bars in requested range for Pro-MTF")

    try:
        ticks = load_ticks(symbol, start=start, end=end)
    except FileNotFoundError as e:
        raise HTTPException(409, str(e)) from e

    try:
        result = run_backtest(
            scoped,
            symbol=symbol,
            tf_minutes=tf,
            wait_and_trade=wait_and_trade,
            rr=rr,
            volume=volume,
            threshold=threshold,
            entry_after=entry_after,
            entry_before=entry_before,
            exit_time=exit_time,
            trade_mode=trade_mode,
            slippage_pct=slippage_pct,
            fee_pct=fee_pct,
            time_stop_minutes=time_stop_minutes,
            re_entry=1 if int(re_entry or 0) else 0,
            stop_to_be=1 if int(stop_to_be or 0) else 0,
            break_even=1 if int(break_even or 0) else 0,
            break_even_pct=float(break_even_pct if break_even_pct is not None else 50),
            pro_mode=bool(pro_mode),
            pro_vwap_sigma=float(pro_vwap_sigma if pro_vwap_sigma is not None else 2),
            ticks=ticks,
            allowed_entry_hours=allowed_entry_hours,
            sl_tp_unit=sl_tp_unit,
            stop_loss=float(stop_loss),
            take_profit=float(take_profit),
            trail_stop=1 if int(trail_stop or 0) else 0,
            risk_on=1 if int(risk_on if risk_on is not None else 1) else 0,
            sl_on=sl_on,
            tp_on=tp_on,
            sl_unit=sl_unit,
            tp_unit=tp_unit,
            trail_unit=trail_unit,
            trail_value=float(trail_value if trail_value is not None else 0),
            be_unit=be_unit,
            be_value=float(be_value if be_value is not None else 0),
            be_ctc=float(be_ctc if be_ctc is not None else 2),
            pro_mtf_mode=bool(pro_mtf_mode),
            base_tf_minutes=int(base_tf),
            base_threshold=float(base_threshold),
            base_bars=base_scoped,
        )
    except FileNotFoundError as e:
        raise HTTPException(409, str(e)) from e
    report = write_parity_report(result)
    parity_checked = (
        tf == 15
        and start == "2026-08-01"
        and not wait_and_trade
        and not pro_mode
        and abs(rr - 1.0) < 1e-9
        and abs(threshold - 50.0) < 1e-9
        and trade_mode == 2
        and abs(slippage_pct) < 1e-12
        and abs(fee_pct) < 1e-12
    )
    parity_errors = check_parity_aug1(result) if parity_checked else []

    payload = result_to_jsonable(result)
    payload["parity_checked"] = parity_checked
    payload["parity_ok"] = (len(parity_errors) == 0) if parity_checked else None
    payload["parity_errors"] = parity_errors
    payload["report_path"] = str(report)
    payload["engine"] = ENGINE_ID
    payload["availability"] = avail
    payload["params"] = round_obj(
        {
            "exchange": exchange,
            "symbol": symbol,
            "tf": tf,
            "wait_and_trade": wait_and_trade,
            "pro_mode": bool(pro_mode),
            "pro_vwap_sigma": float(pro_vwap_sigma if pro_vwap_sigma is not None else 2),
            "rr": rr,
            "volume": volume,
            "threshold": threshold,
            "entry_after": entry_after,
            "entry_before": entry_before,
            "exit_time": exit_time,
            "trade_mode": trade_mode,
            "slippage_pct": slippage_pct,
            "fee_pct": fee_pct,
            "time_stop_minutes": time_stop_minutes,
            "re_entry": 1 if int(re_entry or 0) else 0,
            "stop_to_be": 1 if int(stop_to_be or 0) else 0,
            "break_even": 1 if int(break_even or 0) else 0,
            "break_even_pct": float(break_even_pct if break_even_pct is not None else 50),
            "sl_tp_unit": sl_tp_unit,
            "stop_loss": float(stop_loss),
            "take_profit": float(take_profit),
            "trail_stop": 1 if int(trail_stop or 0) else 0,
            "risk_on": 1 if int(risk_on if risk_on is not None else 1) else 0,
            "sl_on": sl_on if sl_on is not None else (1 if int(risk_on if risk_on is not None else 1) else 0),
            "tp_on": tp_on if tp_on is not None else (1 if int(risk_on if risk_on is not None else 1) else 0),
            "sl_unit": sl_unit or sl_tp_unit,
            "tp_unit": tp_unit or sl_tp_unit,
            "trail_unit": trail_unit,
            "trail_value": float(trail_value if trail_value is not None else 0),
            "be_unit": be_unit,
            "be_value": float(be_value if be_value is not None else 0),
            "be_ctc": float(be_ctc if be_ctc is not None else 2),
            "pro_mtf_mode": bool(pro_mtf_mode),
            "base_tf": int(base_tf),
            "base_threshold": float(base_threshold),
            "start": start,
            "end": end,
            "dayofweek": dayofweek,
            "allowed_entry_hours": allowed_entry_hours,
        }
    )
    return payload


@app.get("/api/optimize")
def optimize(
    symbol: str = "ETHUSDT",
    tf: int = Query(15, alias="tf"),
    volume: float = 0.01,
    thresholds: str = "40,50,60",
    rrs: str = "0.5,1,1.5,2",
    wait_flags: str = "false,true",
    re_entry_flags: str = "0,1",
    stop_to_be_flags: str = "0,1",
    break_even_flags: str = "0,1",
    break_even_pcts: str = "50",
    start: str | None = "2026-08-01",
    end: str | None = "2026-08-03",
    max_runs: int = 400,
    rank_by: str = "sharpe",
    exchange: str = "BINANCE_UM",
    slippage_pct: float = 0.0,
    fee_pct: float = 0.0,
    common_optimizer: bool = False,
    time_optimizer: bool = False,
    time_step_minutes: int = 30,
    # Empty = no bar-level clock filter (session After/Before/Flat still apply in-engine).
    # Do NOT default to 09:30-21:00 — an omitted/empty timewindow used to silently
    # shrink bars vs Apply→Backtest and caused thr/PnL mismatches (e.g. 7 vs 9 trades).
    timewindow: str = "",
    dayofweek: str = "mon,tue,wed,thu,fri,sat,sun",
    entry_after: int = 330,
    entry_before: int = 1260,
    exit_time: int = 1260,
    entry_after_to: int | None = None,
    entry_before_to: int | None = None,
    exit_time_to: int | None = None,
    slippage_pcts: str | None = None,
    fee_pcts: str | None = None,
    volumes: str | None = None,
    min_trades: int = 0,
    time_stop_minutes: float = 0.0,
    workers: int = 0,
    pro_vwap_sigma: float = 2.0,
    pro_vwap_sigmas: str | None = None,
    sl_tp_unit: str = "range",
    sl_unit: str | None = None,
    tp_unit: str | None = None,
    stop_losses: str | None = "50",
    take_profits: str | None = "100",
    trail_stop_flags: str = "0",
    risk_on_flags: str = "1",
    sl_on_flags: str | None = None,
    tp_on_flags: str | None = None,
    trail_unit: str = "range",
    trail_value: float = 0.0,
    trail_values: str | None = None,
    be_unit: str = "range",
    be_value: float = 0.0,
    be_values: str | None = None,
    be_ctc: float = 2.0,
    stream: bool = False,
    base_tfs: str | None = None,
    base_thresholds: str | None = None,
):
    _ensure_ready(exchange, symbol, start or "2026-08-01", end or "2026-08-03", tf)
    if "mtf" in (wait_flags or "").lower():
        for raw in (base_tfs or "15,30,60").split(","):
            raw = raw.strip()
            if not raw:
                continue
            try:
                btf = int(float(raw))
            except ValueError:
                continue
            if btf > int(tf):
                _ensure_ready(exchange, symbol, start or "2026-08-01", end or "2026-08-03", btf)

    bars = _load_bars(symbol, tf)
    scoped = _scope_bars(bars, start, end)
    if scoped.empty:
        raise HTTPException(400, "No bars in requested range")
    try:
        ticks = load_ticks(symbol, start=start, end=end)
    except FileNotFoundError as e:
        raise HTTPException(409, str(e)) from e

    opt_kwargs = dict(
        symbol=symbol,
        tf_minutes=tf,
        volume=volume,
        volumes=volumes,
        thresholds=thresholds,
        rrs=rrs,
        wait_flags=wait_flags,
        re_entry_flags=re_entry_flags,
        stop_to_be_flags=stop_to_be_flags,
        break_even_flags=break_even_flags,
        break_even_pcts=break_even_pcts,
        sl_tp_unit=sl_tp_unit,
        sl_unit=sl_unit,
        tp_unit=tp_unit,
        stop_losses=stop_losses,
        take_profits=take_profits,
        trail_stop_flags=trail_stop_flags,
        risk_on_flags=risk_on_flags,
        sl_on_flags=sl_on_flags,
        tp_on_flags=tp_on_flags,
        trail_unit=trail_unit,
        trail_value=trail_value,
        trail_values=trail_values,
        be_unit=be_unit,
        be_value=be_value,
        be_values=be_values,
        be_ctc=be_ctc,
        max_runs=max_runs,
        rank_by=rank_by,
        common_optimizer=common_optimizer,
        time_optimizer=time_optimizer,
        time_step_minutes=time_step_minutes,
        timewindow=timewindow,
        dayofweek=dayofweek,
        entry_after=entry_after,
        entry_before=entry_before,
        exit_time=exit_time,
        entry_after_to=entry_after_to,
        entry_before_to=entry_before_to,
        exit_time_to=exit_time_to,
        slippage_pct=slippage_pct,
        fee_pct=fee_pct,
        slippage_pcts=slippage_pcts,
        fee_pcts=fee_pcts,
        min_trades=min_trades,
        time_stop_minutes=time_stop_minutes,
        workers=workers,
        pro_vwap_sigma=pro_vwap_sigma,
        pro_vwap_sigmas=pro_vwap_sigmas,
        ticks=ticks,
        base_tfs=base_tfs,
        base_thresholds=base_thresholds,
    )

    if stream:
        def ndjson():
            try:
                for ev in iter_optimize_progress(scoped, **opt_kwargs):
                    if ev.get("type") == "result":
                        payload = ev["payload"]
                        payload["engine"] = ENGINE_ID
                        ev = {"type": "result", "payload": round_obj(payload)}
                    yield json.dumps(ev, default=str) + "\n"
            except GeneratorExit:
                return
            except (ValueError, FileNotFoundError) as e:
                yield json.dumps({"type": "error", "message": str(e)}) + "\n"
            except Exception as e:  # noqa: BLE001
                yield json.dumps({"type": "error", "message": f"Optimize failed: {e}"}) + "\n"

        return StreamingResponse(ndjson(), media_type="application/x-ndjson")

    try:
        out = run_optimize(scoped, **opt_kwargs)
        out["engine"] = ENGINE_ID
        return round_obj(out)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(500, f"Optimize failed: {e}") from e


WEB_DIST = ROOT / "webapp" / "dist"
WEB_LEGACY = ROOT / "web" / "index.html"


@app.get("/")
def index():
    dist_idx = WEB_DIST / "index.html"
    if dist_idx.exists():
        return FileResponse(dist_idx)
    if WEB_LEGACY.exists():
        return FileResponse(WEB_LEGACY)
    raise HTTPException(404, "No web UI built. cd webapp && npm install && npm run build")


if WEB_DIST.exists() and (WEB_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(WEB_DIST / "assets")), name="assets")
elif (ROOT / "web").exists():
    app.mount("/static", StaticFiles(directory=str(ROOT / "web")), name="static")
