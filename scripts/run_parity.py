"""CLI: ingest (if needed) + run parity backtest."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.engine.volume_delta import (
    check_parity_aug1,
    load_bars,
    run_backtest,
    write_parity_report,
)


def main() -> int:
    parquet = ROOT / "data" / "parquet" / "ETHUSDT_15m_bars.parquet"
    if not parquet.exists():
        print("Ingesting aggTrades…")
        from scripts.ingest_aggtrades import ingest_symbol

        ingest_symbol("ETHUSDT", 15)

    bars = load_bars("ETHUSDT", 15)
    import pandas as pd

    bars["open_time"] = pd.to_datetime(bars["open_time"], utc=True)
    scoped = bars[(bars["open_time"] >= "2026-08-01") & (bars["open_time"] < "2026-08-03")]
    print(f"Bars in range: {len(scoped)}")

    result = run_backtest(scoped, wait_and_trade=False, rr=1.0, volume=0.01, threshold=50.0)
    path = write_parity_report(result)
    errors = check_parity_aug1(result)
    print(f"Report: {path}")
    print(f"Stats: {result.stats}")
    for t in result.trades:
        print(
            f"  {t.side} {t.exit_reason} entry={t.entry_time:%H:%M}@{t.entry_price:.2f} "
            f"exit={t.exit_time:%H:%M}@{t.exit_price:.2f} pnl={t.pnl:.4f}"
        )
    if errors:
        print("PARITY FAIL:")
        for e in errors:
            print(" -", e)
        return 1
    print("PARITY OK — matches backend ground truth.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
