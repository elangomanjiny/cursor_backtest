# Cloud path (Phase 1) — demo before a paid VM

v2.2.24 stays a **local engine**. This phase only packages it so you can share a URL.
Data is still **parquet** (`data/`). QuestDB is optional and **not** used by backtest.

## 1. Docker on this PC (same app, isolated process)

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) for Windows.

```powershell
cd E:\cursor_backtest
docker compose up --build
```

Open **http://127.0.0.1:8000/**

First **Data Loader / Run** may download Binance ticks into `./data` (mounted into the container). Keep demo ranges short (a few IST days).

Stop with Ctrl+C, or `docker compose down`.

Optional QuestDB container (health ping only):

```powershell
docker compose --profile questdb up --build
```

## 2. Public demo URL (no paid VM)

Keep Docker or uvicorn running locally, then tunnel:

**Cloudflare Tunnel (free)**

```powershell
cloudflared tunnel --url http://127.0.0.1:8000
```

**ngrok (free)**

```powershell
ngrok http 8000
```

Share the `https://…` link for a short demo. Stop the tunnel when finished. Do not leave it open without auth.

## 3. Later: paid VM / Render / Fly

When you want the app always on:

1. Copy the repo to the VM (or point Render/Fly at this GitHub repo).
2. Build with the same `Dockerfile` (`PORT` is read from the host; Render/Fly set it).
3. Attach a **disk volume** at `/app/data` so ticks survive restarts.
4. Do **not** git-push parquet.

Then we can split backtest/optimize into background jobs and move storage. That is Phase 2 — not required for a demo.

## Out of scope for Phase 1

- Replacing parquet with QuestDB
- Live TradingView-style feeds
- User accounts / multi-tenant
