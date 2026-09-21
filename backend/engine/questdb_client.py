"""Thin QuestDB HTTP client (REST + ILP text). Optional — parquet remains source of truth."""
from __future__ import annotations

import os
import time
from typing import Any
from urllib.parse import quote

import httpx
import pandas as pd

DEFAULT_URL = os.environ.get("QUESTDB_URL", "http://127.0.0.1:9000")
ILP_HOST = os.environ.get("QUESTDB_ILP_HOST", "127.0.0.1")
ILP_PORT = int(os.environ.get("QUESTDB_ILP_PORT", "9009"))

_HEALTH_TTL_SEC = 20.0
_health_cache: tuple[float, dict[str, Any]] | None = None


def health(base_url: str = DEFAULT_URL, timeout: float = 0.4) -> dict[str, Any]:
    global _health_cache
    now = time.monotonic()
    if _health_cache is not None and now - _health_cache[0] < _HEALTH_TTL_SEC:
        return _health_cache[1]
    try:
        r = httpx.get(f"{base_url.rstrip('/')}/settings", timeout=timeout)
        ok = r.status_code == 200
        out: dict[str, Any] = {
            "ok": ok,
            "status_code": r.status_code,
            "url": base_url,
            "version": (r.json().get("config") or {}).get("release.version") if ok else None,
        }
    except Exception as e:  # noqa: BLE001
        out = {"ok": False, "error": str(e), "url": base_url}
    _health_cache = (now, out)
    return out


def exec_sql(sql: str, base_url: str = DEFAULT_URL, timeout: float = 30.0) -> dict[str, Any]:
    r = httpx.get(
        f"{base_url.rstrip('/')}/exec",
        params={"query": sql},
        timeout=timeout,
    )
    r.raise_for_status()
    return r.json()


def ensure_bars_table(base_url: str = DEFAULT_URL) -> None:
    exec_sql(
        """
        CREATE TABLE IF NOT EXISTS vd_bars (
            symbol SYMBOL,
            tf INT,
            open_time TIMESTAMP,
            open DOUBLE,
            high DOUBLE,
            low DOUBLE,
            close DOUBLE,
            volume_quote DOUBLE,
            delta_quote DOUBLE,
            delta_pct DOUBLE
        ) TIMESTAMP(open_time) PARTITION BY DAY WAL;
        """,
        base_url=base_url,
    )


def upsert_bars(bars: pd.DataFrame, symbol: str, tf: int, base_url: str = DEFAULT_URL) -> int:
    """Insert bars via /exec VALUES batches (fine for MVP sizes)."""
    ensure_bars_table(base_url)
    df = bars.copy()
    df["open_time"] = pd.to_datetime(df["open_time"], utc=True)
    n = 0
    batch: list[str] = []
    for _, row in df.iterrows():
        ts = row["open_time"].strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        batch.append(
            f"('{symbol}',{tf},'{ts}',{float(row['open'])},{float(row['high'])},"
            f"{float(row['low'])},{float(row['close'])},{float(row.get('volume_quote', 0))},"
            f"{float(row.get('delta_quote', 0))},{float(row.get('delta_pct', 0))})"
        )
        if len(batch) >= 200:
            sql = (
                "INSERT INTO vd_bars "
                "(symbol,tf,open_time,open,high,low,close,volume_quote,delta_quote,delta_pct) VALUES "
                + ",".join(batch)
            )
            exec_sql(sql, base_url=base_url)
            n += len(batch)
            batch = []
    if batch:
        sql = (
            "INSERT INTO vd_bars "
            "(symbol,tf,open_time,open,high,low,close,volume_quote,delta_quote,delta_pct) VALUES "
            + ",".join(batch)
        )
        exec_sql(sql, base_url=base_url)
        n += len(batch)
    return n


def load_bars_from_questdb(
    symbol: str = "ETHUSDT",
    tf: int = 15,
    start: str | None = None,
    end: str | None = None,
    base_url: str = DEFAULT_URL,
) -> pd.DataFrame:
    where = [f"symbol='{symbol}'", f"tf={tf}"]
    if start:
        where.append(f"open_time >= '{start}'")
    if end:
        where.append(f"open_time < '{end}'")
    sql = (
        "SELECT open_time, open, high, low, close, volume_quote, delta_quote, delta_pct "
        f"FROM vd_bars WHERE {' AND '.join(where)} ORDER BY open_time"
    )
    payload = exec_sql(sql, base_url=base_url)
    cols = [c["name"] for c in payload.get("columns", [])]
    rows = payload.get("dataset", [])
    if not rows:
        return pd.DataFrame(columns=cols)
    df = pd.DataFrame(rows, columns=cols)
    df["open_time"] = pd.to_datetime(df["open_time"], utc=True)
    return df
