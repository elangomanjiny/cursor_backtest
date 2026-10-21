#!/bin/sh
set -eu
PORT="${PORT:-8000}"
exec uvicorn backend.app.main:app --app-dir . --host 0.0.0.0 --port "$PORT"
