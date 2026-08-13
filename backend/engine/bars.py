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
    Optional start/end (YYYY-MM-DD, end exclusive) limits which parts are read.
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
        if start:
            ticks = ticks[ticks["ts"] >= pd.Timestamp(start[:10], tz="UTC")]
        if end:
            ticks = ticks[ticks["ts"] < pd.Timestamp(end[:10], tz="UTC")]
        if ticks.empty:
            raise FileNotFoundError(f"No ticks in {legacy.name} for requested range.")
        return ticks.reset_index(drop=True)
    raise FileNotFoundError(
        f"Missing ticks for {symbol}. Run Step 1 Load data "
        f"(expected {parts_dir.name}/ or {legacy.name})."
    )


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
