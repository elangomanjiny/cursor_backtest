"""
NautilusTrader bridge.

MVP keeps the proven bar simulator as the parity engine. This module reports
whether nautilus_trader is installed and exposes a thin run() that delegates
to volume_delta so the UI/API can switch engines later without breaking parity.
"""
from __future__ import annotations

from typing import Any

import pandas as pd

from backend.engine.volume_delta import result_to_jsonable, run_backtest

try:
    import nautilus_trader  # type: ignore

    NAUTILUS_AVAILABLE = True
    NAUTILUS_VERSION = getattr(nautilus_trader, "__version__", "unknown")
except Exception:  # noqa: BLE001
    NAUTILUS_AVAILABLE = False
    NAUTILUS_VERSION = None


def status() -> dict[str, Any]:
    return {
        "available": NAUTILUS_AVAILABLE,
        "version": NAUTILUS_VERSION,
        "execution": "volume_delta_hybrid",
        "note": (
            "Execution engine: bar signals + aggTrade tick exits. "
            "Full Nautilus strategy adapter is next once available=true."
            if NAUTILUS_AVAILABLE
            else "Install with: pip install nautilus_trader (Windows wheels may vary)."
        ),
    }


def run(
    bars: pd.DataFrame,
    **kwargs: Any,
) -> dict[str, Any]:
    """Run backtest; currently always volume_delta (parity-safe)."""
    result = run_backtest(bars, **kwargs)
    payload = result_to_jsonable(result)
    payload["engine"] = "volume_delta_bar_sim"
    payload["nautilus"] = status()
    return payload
