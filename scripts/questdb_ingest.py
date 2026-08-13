"""Push parquet bars into local QuestDB (must already be running)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.engine.questdb_client import health, upsert_bars  # noqa: E402
from backend.engine.volume_delta import load_bars  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="ETHUSDT")
    ap.add_argument("--tf", type=int, default=15)
    ap.add_argument("--url", default=None)
    args = ap.parse_args()
    url = args.url
    h = health(url) if url else health()
    if not h.get("ok"):
        print("QuestDB not reachable:", h)
        print("Start it: .\\tools\\questdb\\questdb.exe start -d .\\tools\\questdb\\data")
        return 1
    bars = load_bars(args.symbol, args.tf)
    n = upsert_bars(bars, args.symbol, args.tf, base_url=url or h["url"])
    print(f"Inserted {n} bars into QuestDB vd_bars ({args.symbol} {args.tf}m)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
