"""Load ~6m ETHUSDT ticks if needed, then run Pro-MTF 3m/70 vs 15m/30."""
from __future__ import annotations

import json
import sys
import traceback
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.engine.bars import ensure_bars_cover, load_ticks
from backend.engine.dataloader import (
    _ensure_tick_part,
    ist_bounds,
    ist_lookback_start,
    utc_days_covering_ist,
)
from backend.engine.volume_delta import result_to_jsonable, run_backtest

START = "2026-03-01"
END = "2026-08-29"
SYMBOL = "ETHUSDT"
OUT = ROOT / "logs" / "backtest-promtf-3m-6m.json"


def main() -> None:
    days = utc_days_covering_ist(START, END)
    print(f"UTC days covering IST {START} to {END}: {len(days)} ({days[0]} .. {days[-1]})", flush=True)
    reused = downloaded = skipped = 0
    for i, d in enumerate(days, 1):
        try:
            _part, was_reused = _ensure_tick_part(SYMBOL, d)
            if was_reused:
                reused += 1
                tag = "reused"
            else:
                downloaded += 1
                tag = "downloaded"
            print(f"[{i}/{len(days)}] {tag} {d.isoformat()}", flush=True)
        except FileNotFoundError as e:
            skipped += 1
            print(f"[{i}/{len(days)}] SKIP {d.isoformat()} {e}", flush=True)
    print(f"ticks ready reused={reused} downloaded={downloaded} skipped={skipped}", flush=True)

    print("building/covering 3m bars...", flush=True)
    bars = ensure_bars_cover(SYMBOL, 3, START, END)
    bars["open_time"] = __import__("pandas").to_datetime(bars["open_time"], utc=True)
    t0, t1 = ist_bounds(START, END)
    scoped = bars[(bars["open_time"] >= t0) & (bars["open_time"] < t1)].copy()
    print(f"3m bars in window {len(scoped)} first={scoped['open_time'].min()} last={scoped['open_time'].max()}", flush=True)
    if scoped.empty:
        raise SystemExit("No 3m bars in IST window")

    htf_start = ist_lookback_start(START, 2)
    print(f"building/covering 15m HTF {htf_start} to {END}...", flush=True)
    htf = ensure_bars_cover(SYMBOL, 15, htf_start, END)
    htf["open_time"] = __import__("pandas").to_datetime(htf["open_time"], utc=True)
    ht0, ht1 = ist_bounds(htf_start, END)
    htf = htf[(htf["open_time"] >= ht0) & (htf["open_time"] < ht1)].copy()
    print(f"15m HTF bars {len(htf)} first={htf['open_time'].min()} last={htf['open_time'].max()}", flush=True)

    print("loading ticks for hybrid exits...", flush=True)
    ticks = load_ticks(SYMBOL, start=START, end=END)
    print(f"ticks {len(ticks)} {ticks['ts'].min()} -> {ticks['ts'].max()}", flush=True)

    print("running Pro-MTF backtest...", flush=True)
    result = run_backtest(
        scoped,
        symbol=SYMBOL,
        tf_minutes=3,
        wait_and_trade=False,
        rr=1.0,
        volume=1.0,
        threshold=70.0,
        entry_after=0,
        entry_before=1380,
        exit_time=1380,
        trade_mode=2,
        slippage_pct=0.005,
        fee_pct=0.05,
        sl_on=0,
        tp_on=0,
        trail_stop=0,
        break_even=0,
        risk_on=0,
        pro_mtf_mode=True,
        base_tf_minutes=15,
        base_threshold=30.0,
        base_bars=htf,
        ticks=ticks,
    )
    payload = result_to_jsonable(result)
    trades = payload.get("trades") or []
    stats = payload.get("stats") or {}
    print(
        f"RESULT trades={len(trades)} aggr={len(payload.get('aggressive') or [])} "
        f"net={stats.get('net_pnl')} win={stats.get('win_rate')} exits={stats.get('exits')}",
        flush=True,
    )
    keep = {k: payload[k] for k in payload if k not in ("bars", "equity")}
    keep["equity_n"] = len(payload.get("equity") or [])
    keep["bars_n"] = len(payload.get("bars") or [])
    keep["window"] = {"start": START, "end": END, "tz": "Asia/Kolkata"}
    keep["tick_prep"] = {"reused": reused, "downloaded": downloaded, "skipped": skipped}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(keep, indent=2), encoding="utf-8")
    print(f"wrote {OUT}", flush=True)
    for i, t in enumerate(trades[:15], 1):
        print(
            f"#{i} {t.get('side')} {t.get('exit_reason')} "
            f"{t.get('entry_time')} @{t.get('entry_price')} -> {t.get('exit_time')} "
            f"@{t.get('exit_price')} pnl={t.get('pnl')}",
            flush=True,
        )
    if len(trades) > 15:
        print(f"... {len(trades) - 15} more trades in {OUT.name}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)
