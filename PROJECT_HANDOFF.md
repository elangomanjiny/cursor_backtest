# cursor_backtest — handoff (v1.2.7)

Saved for next session discussion. Last updated: 2026-08-08.

## What it is

Local volume-delta research terminal:

**Binance UM aggTrades → parquet bars → Python bar sim → FastAPI → React UI**

Path: `E:\cursor_backtest`  
UI: http://127.0.0.1:8000/  
Run API: `uvicorn backend.app.main:app --app-dir . --reload --port 8000` from project root  
Rebuild UI: `cd webapp && npm run build`

## Flow

1. **Data Loader** — load exchange/symbol/dates/TF → Vision ZIPs → ticks/bars/manifest  
2. **Backtest** — Run strategy; subtabs Visualization / Trades / Equity + metrics  
3. **Optimize** — grid Threshold × RR × Wait; optional common time/DOW; CSV; Apply best → Backtest  

After first Run, param changes auto-rerun (~350ms).

## Where data lives

| Kind | Path |
|------|------|
| Raw ZIPs | `data/raw/` |
| Ticks | `data/parquet/{SYMBOL}_ticks.parquet` |
| Bars | `data/parquet/{SYMBOL}_{tf}m_bars.parquet` |
| Manifests | `data/manifests/` |
| Parity logs | `logs/` |
| Built UI | `webapp/dist/` |

Loading a new range **overwrites** that symbol’s parquet. QuestDB is optional and **not** used by backtest.

## Engines

- **Backtest (core):** `backend/engine/volume_delta.py` — `volume_delta_hybrid` (bar signals + aggTrade tick exits). Not Nautilus fills.  
- **Optimize:** `backend/engine/optimize.py` — same hybrid engine over a param grid + metrics rank.  
- **Metrics:** `backend/engine/metrics.py`  
- **Nautilus / QuestDB:** stubs / optional only.

## Parity ground truth

ETHUSDT 15m, 2026-08-01 → 2026-08-03, Wait=false, RR=1, Thr=50, slip/fee=0:

- Aggressive Sell ~**15:15** → Short entry ~**15:30** @ ~1866.98 → ST @ ~1864.49 → PnL ~**+0.02**  
- StockSharp Designer / VolumeDeltaCompare is the reference; Python sim must match.

## Key UI behaviors (recent)

- Trades **Time** = signal/aggressive candle (15:15), not entry (15:30)  
- Slip% / Fee% on STRATEGY strip (backtest + optimize)  
- Chart: entry/target/stop **rays** + markers like `SE @ 1866.56 - 0.01`  
- Zoom persists across Visualization ↔ Trades ↔ Optimize  
- Trades / Aggressive panes split 50/50 with scroll  
- Compact metrics bar  

## Version trail (short)

- **1.0** — ingest, bar sim, API, thin chart, parity  
- **1.1** — strategy panel, TF, vol/delta panes, zoom, auto-rerun  
- **1.2.x** — stepper UI, metrics, optimize + common filters + CSV  
- **1.2.5** — single control strip; rays; optimize NaN fix  
- **1.2.6** — signal time; slip/fee; split tables; marker labels; compact metrics  
- **1.2.7** — hybrid engine (OHLC confirmation + tick exits); chart timeScale IST  

Authoritative version: `APP_VERSION` in `backend/app/main.py` and `webapp/package.json` (= **1.2.7**).

## Understanding checkpoints

- Fills come from **Python bar sim**, not Designer at runtime  
- Designer = **parity reference** only  
- `@stocksharp/chart` = chart UI only  
- Optimize uses the **same** engine, many combos  
- Footprint disabled (perf)  

## Discuss tomorrow

- Product direction / next features  
- Whether to push Nautilus for real execution  
- QuestDB role vs parquet  
- README sync (still mentions older 1.2.2 in places)  
- Any UX or parity gaps from live use  
