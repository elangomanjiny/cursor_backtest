"""Exchange data loader: Binance UM aggTrades download → parquet → availability.

Supports up to ~1 year by downloading day-by-day and storing tick parts on disk
(so RAM is not forced to hold the entire year at once during ingest).
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import pandas as pd

from scripts.ingest_aggtrades import _read_aggtrades_zip, build_ohlc_and_delta

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
PARQUET = ROOT / "data" / "parquet"
MANIFESTS = ROOT / "data" / "manifests"

BINANCE_UM = "https://data.binance.vision/data/futures/um/daily/aggTrades"
SUPPORTED_EXCHANGES = ("BINANCE_UM",)
SUPPORTED_TF = (1, 3, 5, 15, 30, 60)

# Hybrid tick backtests need disk space; 370 ≈ 1y + leap cushion.
MAX_LOAD_DAYS = 370


def _daterange(start: str, end: str, *, max_days: int = MAX_LOAD_DAYS) -> list[date]:
    s = date.fromisoformat(start[:10])
    e = date.fromisoformat(end[:10])
    if e <= s:
        raise ValueError("end date must be after start date")
    days = (e - s).days
    if days > max_days:
        raise ValueError(
            f"Date range limited to {max_days} days (~1 year). "
            f"Requested {days} days ({start[:10]} to {end[:10]})."
        )
    out = []
    cur = s
    while cur < e:
        out.append(cur)
        cur += timedelta(days=1)
    return out


def _zip_path(symbol: str, d: date) -> Path:
    return RAW / f"{symbol}-aggTrades-{d.isoformat()}.zip"


def _zip_url(symbol: str, d: date) -> str:
    return f"{BINANCE_UM}/{symbol}/{symbol}-aggTrades-{d.isoformat()}.zip"


def ticks_parts_dir(symbol: str) -> Path:
    return PARQUET / f"{symbol}_ticks"


def tick_part_path(symbol: str, d: date) -> Path:
    return ticks_parts_dir(symbol) / f"part-{d.isoformat()}.parquet"


def legacy_ticks_path(symbol: str) -> Path:
    return PARQUET / f"{symbol}_ticks.parquet"


def _manifest_path(exchange: str, symbol: str, tf: int) -> Path:
    return MANIFESTS / f"{exchange}_{symbol}_{tf}m.json"


def download_day(symbol: str, d: date, timeout: float = 180.0) -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    path = _zip_path(symbol, d)
    if path.exists() and path.stat().st_size > 1000:
        return path
    url = _zip_url(symbol, d)
    with httpx.stream("GET", url, timeout=timeout, follow_redirects=True) as r:
        if r.status_code == 404:
            raise FileNotFoundError(f"No Binance Vision file for {symbol} {d.isoformat()}")
        r.raise_for_status()
        tmp = path.with_suffix(".partial")
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)
        tmp.replace(path)
    return path


def _ensure_tick_part(symbol: str, d: date) -> tuple[Path, bool]:
    """
    Ensure daily tick parquet exists. Returns (path, reused).
    Parses the zip only when the part is missing.
    """
    part = tick_part_path(symbol, d)
    if part.exists() and part.stat().st_size > 500:
        return part, True
    ticks_parts_dir(symbol).mkdir(parents=True, exist_ok=True)
    zpath = download_day(symbol, d)
    day_ticks = _read_aggtrades_zip(zpath)
    # Keep only that UTC calendar day
    t0 = pd.Timestamp(d.isoformat(), tz="UTC")
    t1 = t0 + pd.Timedelta(days=1)
    day_ticks = day_ticks[(day_ticks["ts"] >= t0) & (day_ticks["ts"] < t1)]
    day_ticks.to_parquet(part, index=False)
    return part, False


def load_tick_parts(
    symbol: str,
    *,
    start: str | None = None,
    end: str | None = None,
) -> pd.DataFrame:
    """
    Load tick rows for [start, end). Prefers daily parts directory; falls back
    to legacy single-file parquet.
    """
    symbol = symbol.upper()
    t0 = pd.Timestamp(start[:10], tz="UTC") if start else None
    t1 = pd.Timestamp(end[:10], tz="UTC") if end else None

    parts_dir = ticks_parts_dir(symbol)
    frames: list[pd.DataFrame] = []

    if parts_dir.is_dir():
        parts = sorted(parts_dir.glob("part-*.parquet"))
        for p in parts:
            # part-YYYY-MM-DD.parquet
            try:
                day = date.fromisoformat(p.stem.replace("part-", "")[:10])
            except ValueError:
                continue
            if t0 is not None and day < t0.date():
                continue
            if t1 is not None and day >= t1.date():
                continue
            frames.append(pd.read_parquet(p))
    else:
        legacy = legacy_ticks_path(symbol)
        if legacy.exists():
            frames.append(pd.read_parquet(legacy))

    if not frames:
        return pd.DataFrame(columns=["ts", "price", "quantity", "quote", "aggressor_sell"])

    ticks = pd.concat(frames, ignore_index=True)
    ticks["ts"] = pd.to_datetime(ticks["ts"], utc=True)
    if t0 is not None:
        ticks = ticks[ticks["ts"] >= t0]
    if t1 is not None:
        ticks = ticks[ticks["ts"] < t1]
    return ticks.sort_values("ts").reset_index(drop=True)


def load_dataset(
    *,
    exchange: str = "BINANCE_UM",
    symbol: str = "ETHUSDT",
    start: str = "2026-08-01",
    end: str = "2026-08-03",
    tf: int = 15,
) -> dict[str, Any]:
    exchange = exchange.upper()
    symbol = symbol.upper()
    if exchange not in SUPPORTED_EXCHANGES:
        raise ValueError(f"Unsupported exchange {exchange}. Use one of {SUPPORTED_EXCHANGES}")
    if tf not in SUPPORTED_TF:
        raise ValueError(f"tf must be one of {SUPPORTED_TF}")

    days = _daterange(start, end)
    downloaded: list[str] = []
    reused: list[str] = []
    bar_frames: list[pd.DataFrame] = []
    tick_rows = 0

    for d in days:
        part, was_reused = _ensure_tick_part(symbol, d)
        (reused if was_reused else downloaded).append(d.isoformat())
        day_ticks = pd.read_parquet(part)
        day_ticks["ts"] = pd.to_datetime(day_ticks["ts"], utc=True)
        tick_rows += int(len(day_ticks))
        if not day_ticks.empty:
            bar_frames.append(build_ohlc_and_delta(day_ticks, tf))

    if not bar_frames:
        raise RuntimeError("No ticks after load/clip — check symbol/dates on Binance Vision.")

    bars = pd.concat(bar_frames, ignore_index=True).sort_values("open_time").reset_index(drop=True)
    # Clip bars to requested window (exclusive end)
    t0 = pd.Timestamp(start[:10], tz="UTC")
    t1 = pd.Timestamp(end[:10], tz="UTC")
    bars["open_time"] = pd.to_datetime(bars["open_time"], utc=True)
    bars = bars[(bars["open_time"] >= t0) & (bars["open_time"] < t1)]
    if bars.empty:
        raise RuntimeError("No bars after load/clip — check symbol/dates on Binance Vision.")

    PARQUET.mkdir(parents=True, exist_ok=True)
    bar_out = PARQUET / f"{symbol}_{tf}m_bars.parquet"
    bars.to_parquet(bar_out, index=False)

    # Keep a small legacy single-file cache only for short windows (compat / quick tools)
    if len(days) <= 14:
        ticks = load_tick_parts(symbol, start=start, end=end)
        ticks.to_parquet(legacy_ticks_path(symbol), index=False)

    first = bars["open_time"].min()
    last = bars["open_time"].max()
    manifest = {
        "exchange": exchange,
        "symbol": symbol,
        "tf": tf,
        "start": start[:10],
        "end": end[:10],
        "bars": int(len(bars)),
        "ticks": int(tick_rows),
        "tick_parts": str(ticks_parts_dir(symbol).relative_to(ROOT)).replace("\\", "/"),
        "first_bar": pd.Timestamp(first).isoformat(),
        "last_bar": pd.Timestamp(last).isoformat(),
        "downloaded_days": downloaded,
        "reused_days": reused,
        "loaded_at": datetime.now(timezone.utc).isoformat(),
        "ready": True,
        "max_load_days": MAX_LOAD_DAYS,
    }
    MANIFESTS.mkdir(parents=True, exist_ok=True)
    _manifest_path(exchange, symbol, tf).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def data_availability(
    *,
    exchange: str = "BINANCE_UM",
    symbol: str = "ETHUSDT",
    start: str = "2026-08-01",
    end: str = "2026-08-03",
    tf: int = 15,
) -> dict[str, Any]:
    exchange = exchange.upper()
    symbol = symbol.upper()
    checks: list[dict[str, Any]] = []

    man_path = _manifest_path(exchange, symbol, tf)
    manifest = None
    if man_path.exists():
        manifest = json.loads(man_path.read_text(encoding="utf-8"))

    tick_path = legacy_ticks_path(symbol)
    parts_dir = ticks_parts_dir(symbol)
    bar_path = PARQUET / f"{symbol}_{tf}m_bars.parquet"
    ticks_ok = tick_path.exists() or (parts_dir.is_dir() and any(parts_dir.glob("part-*.parquet")))

    checks.append(
        {
            "id": "ticks",
            "label": "Tick parquet",
            "ok": ticks_ok,
            "detail": (
                f"{parts_dir.name}/ parts"
                if parts_dir.is_dir() and any(parts_dir.glob("part-*.parquet"))
                else (str(tick_path.name) if tick_path.exists() else "missing")
            ),
        }
    )
    checks.append(
        {
            "id": "bars",
            "label": f"{tf}m bars parquet",
            "ok": bar_path.exists(),
            "detail": str(bar_path.name) if bar_path.exists() else "missing",
        }
    )

    bars_in_range = 0
    coverage_ok = False
    first_iso = last_iso = None
    if bar_path.exists():
        bars = pd.read_parquet(bar_path)
        bars["open_time"] = pd.to_datetime(bars["open_time"], utc=True)
        t0 = pd.Timestamp(start[:10], tz="UTC")
        t1 = pd.Timestamp(end[:10], tz="UTC")
        scoped = bars[(bars["open_time"] >= t0) & (bars["open_time"] < t1)]
        bars_in_range = int(len(scoped))
        if bars_in_range > 0:
            first_iso = scoped["open_time"].iloc[0].isoformat()
            last_iso = scoped["open_time"].iloc[-1].isoformat()
            coverage_ok = bars_in_range >= max(1, (24 * 60 // tf) // 4)

    checks.append(
        {
            "id": "range",
            "label": "Bars in selected date range",
            "ok": bars_in_range > 0,
            "detail": f"{bars_in_range} bars" + (f" ({first_iso} → {last_iso})" if first_iso else ""),
        }
    )
    checks.append(
        {
            "id": "coverage",
            "label": "Coverage sufficient for backtest",
            "ok": coverage_ok,
            "detail": "ok" if coverage_ok else "too few bars in range",
        }
    )

    try:
        days = _daterange(start, end)
        missing = [
            d.isoformat()
            for d in days
            if not (
                (tick_part_path(symbol, d).exists() and tick_part_path(symbol, d).stat().st_size > 500)
                or (_zip_path(symbol, d).exists() and _zip_path(symbol, d).stat().st_size > 1000)
            )
        ]
        checks.append(
            {
                "id": "raw",
                "label": "Daily aggTrades / tick parts",
                "ok": len(missing) == 0,
                "detail": (
                    "all present"
                    if not missing
                    else f"missing {len(missing)} day(s): {', '.join(missing[:5])}{'…' if len(missing) > 5 else ''}"
                ),
            }
        )
    except ValueError as e:
        checks.append({"id": "raw", "label": "Daily aggTrades / tick parts", "ok": False, "detail": str(e)})

    ready = all(c["ok"] for c in checks)
    return {
        "ready": ready,
        "exchange": exchange,
        "symbol": symbol,
        "tf": tf,
        "start": start[:10],
        "end": end[:10],
        "bars_in_range": bars_in_range,
        "first_bar": first_iso,
        "last_bar": last_iso,
        "checks": checks,
        "manifest": manifest,
        "max_load_days": MAX_LOAD_DAYS,
    }
