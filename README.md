# cursor_backtest **v1.2.2**

Local volume-delta research terminal:

**Data Loader → Strategy Backtest → Optimization**

Parity gate (unchanged from v1.0/v1.1): ETHUSDT 15m, 2026-08-01…02 → SE 15:30 @ ~1866.98 → ST same bar → PnL ~+0.02 USDT.

## Workflow

| Step | What |
|------|------|
| **1. Data Loader** | Single-row Exchange · Symbol · Start · End · TF → load; OHLCV table below; title turns green when ready |
| **2. Backtest** | Params + chart (legends, tooltip, Quote/Base toggle, bottom +/−/↺/⇥) + stats; auto-rerun after first Run |
| **3. Optimize** | Grid + optional **Common optimizer** (time window IST, day-of-week) |

## Quick start

```powershell
cd E:\cursor_backtest
.\.venv\Scripts\Activate.ps1
uvicorn backend.app.main:app --app-dir . --reload --port 8000

# UI rebuild after frontend changes
cd webapp
npm run build
```

Open http://127.0.0.1:8000/

## Notes

- Date range load limited to **14 days** (Vision download size).
- Numbers rounded to **2 decimals**.
- Footprint chart disabled (perf) — volume / delta / delta% panes remain.
- v1.1 engine + parity path preserved under the new step UI.
