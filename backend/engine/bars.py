"""Load or build OHLCV+delta bars for any timeframe from tick parquet."""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts.ingest_aggtrades import build_ohlc_and_delta  # noqa: E402

PARQUET = ROOT / "data" / "parquet"
SUPPORTED_TF = (1, 3, 5, 15, 30, 60)


def load_ticks(
    symbol: str = "ETHUSDT",
    *,
    start: str | None = None,
    end: str | None = None,
) -> pd.DataFrame:
    """
    Load aggTrade ticks for symbol.
    Prefers daily parts under parquet/{symbol}_ticks/; falls back to legacy
    single-file parquet/{symbol}_ticks.parquet.
    Optional start/end (YYYY-MM-DD IST, end exclusive) limits which parts are read.
    """
    from backend.engine.dataloader import load_tick_parts, legacy_ticks_path, ticks_parts_dir

    symbol = symbol.upper()
    parts_dir = ticks_parts_dir(symbol)
    legacy = legacy_ticks_path(symbol)
    if parts_dir.is_dir() and any(parts_dir.glob("part-*.parquet")):
        ticks = load_tick_parts(symbol, start=start, end=end)
        if ticks.empty:
            raise FileNotFoundError(
                f"No tick parts for {symbol} in range {start}→{end}. "
                "Load data in Step 1 for that window."
            )
        return ticks
    if legacy.exists():
        ticks = pd.read_parquet(legacy)
        ticks["ts"] = pd.to_datetime(ticks["ts"], utc=True)
        from backend.engine.dataloader import ist_bounds

        t0, t1 = ist_bounds(start, end)
        if t0 is not None:
            ticks = ticks[ticks["ts"] >= t0]
        if t1 is not None:
            ticks = ticks[ticks["ts"] < t1]
        if ticks.empty:
            raise FileNotFoundError(f"No ticks in {legacy.name} for requested range.")
        return ticks.reset_index(drop=True)
    raise FileNotFoundError(
        f"Missing ticks for {symbol}. Run Step 1 Load data "
        f"(expected {parts_dir.name}/ or {legacy.name})."
    )


def bars_cover_window(
    bars: pd.DataFrame | None,
    t0: pd.Timestamp,
    t1: pd.Timestamp,
    tf_minutes: int,
    *,
    min_frac: float = 0.9,
) -> bool:
    """True if `bars` actually span UTC [t0, t1) at this TF (gaps fail, not just first/last)."""
    if bars is None or getattr(bars, "empty", True) or t0 is None or t1 is None:
        return False
    tf = pd.Timedelta(minutes=int(tf_minutes))
    ot = pd.to_datetime(bars["open_time"], utc=True)
    overlap = bars[(ot + tf > t0) & (ot < t1)]
    if overlap.empty:
        return False
    first = overlap["open_time"].min()
    last = overlap["open_time"].max()
    if first > t0:
        return False
    if last + tf < t1:
        return False
    expected = max(1, int(round((t1 - t0) / tf)))
    if len(overlap) < max(1, int(expected * min_frac)):
        return False
    return True


def load_or_build_bars(symbol: str = "ETHUSDT", tf_minutes: int = 15) -> pd.DataFrame:
    if tf_minutes not in SUPPORTED_TF:
        raise ValueError(f"tf must be one of {SUPPORTED_TF}, got {tf_minutes}")
    path = PARQUET / f"{symbol}_{tf_minutes}m_bars.parquet"
    if path.exists():
        return pd.read_parquet(path)
    ticks = load_ticks(symbol)
    bars = build_ohlc_and_delta(ticks, tf_minutes)
    PARQUET.mkdir(parents=True, exist_ok=True)
    bars.to_parquet(path, index=False)
    return bars


def ensure_bars_cover(
    symbol: str,
    tf_minutes: int,
    start: str,
    end: str,
) -> pd.DataFrame:
    """
    Return bars covering IST [start, end). If the parquet is missing, short,
    or gapped inside the window, rebuild that TF from ticks and merge onto disk.
    """
    if tf_minutes not in SUPPORTED_TF:
        raise ValueError(f"tf must be one of {SUPPORTED_TF}, got {tf_minutes}")
    from backend.engine.dataloader import ist_bounds

    symbol = symbol.upper()
    t0, t1 = ist_bounds(start, end)
    if t0 is None or t1 is None:
        raise ValueError("start and end required")
    path = PARQUET / f"{symbol}_{tf_minutes}m_bars.parquet"
    existing: pd.DataFrame | None = None
    if path.exists():
        existing = pd.read_parquet(path)
        existing["open_time"] = pd.to_datetime(existing["open_time"], utc=True)
        if bars_cover_window(existing, t0, t1, tf_minutes):
            return existing
    ticks = load_ticks(symbol, start=start, end=end)
    built = build_ohlc_and_delta(ticks, tf_minutes)
    built["open_time"] = pd.to_datetime(built["open_time"], utc=True)
    if existing is not None and not existing.empty:
        bars = pd.concat([existing, built], ignore_index=True)
        bars = bars.drop_duplicates(subset=["open_time"]).sort_values("open_time")
        bars = bars.reset_index(drop=True)
    else:
        bars = built.sort_values("open_time").reset_index(drop=True)
    PARQUET.mkdir(parents=True, exist_ok=True)
    bars.to_parquet(path, index=False)
    return bars
