"""Orderflow signal bands: range BB(20,1) + rolling σ for volume / |delta|."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

RANGE_BB_PERIOD = 20
RANGE_BB_K = 1.0
VOL_STAT_PERIOD = 20


def _prior_mean_std(arr: np.ndarray, period: int) -> tuple[np.ndarray, np.ndarray]:
    """Mean/std of the previous `period` bars (current bar is not in the window)."""
    s = pd.Series(arr, dtype="float64").shift(1)
    mean = s.rolling(period, min_periods=period).mean()
    std = s.rolling(period, min_periods=period).std(ddof=0)
    return mean.to_numpy(dtype=np.float64), std.to_numpy(dtype=np.float64)


def _num(x: Any) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(v):
        return None
    return v


def attach_bb_stats(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Attach prior-window Bollinger / σ stats to orderflow bars.

    rangeUpper = SMA20(prev ranges) + 1·σ  — absorption only if high-low ≤ this.
    volMid/Std and dAbsMid/Std are 20-bar prior mean/σ for Big* and absorption volume.
    """
    if not rows:
        return rows
    high = np.array([float(r.get("high") or 0) for r in rows], dtype=np.float64)
    low = np.array([float(r.get("low") or 0) for r in rows], dtype=np.float64)
    rng = np.maximum(high - low, 0.0)
    r_mean, r_std = _prior_mean_std(rng, RANGE_BB_PERIOD)
    r_upper = r_mean + RANGE_BB_K * r_std

    vq = np.array([float(r.get("volume_quote") or 0) for r in rows], dtype=np.float64)
    vb = np.array([float(r.get("volume_base") or 0) for r in rows], dtype=np.float64)
    dq = np.abs(np.array([float(r.get("delta_quote") or 0) for r in rows], dtype=np.float64))
    db = np.abs(np.array([float(r.get("delta_base") or 0) for r in rows], dtype=np.float64))

    vq_m, vq_s = _prior_mean_std(vq, VOL_STAT_PERIOD)
    vb_m, vb_s = _prior_mean_std(vb, VOL_STAT_PERIOD)
    dq_m, dq_s = _prior_mean_std(dq, VOL_STAT_PERIOD)
    db_m, db_s = _prior_mean_std(db, VOL_STAT_PERIOD)

    for i, r in enumerate(rows):
        r["range"] = round(float(rng[i]), 6)
        r["rangeMid"] = _num(r_mean[i])
        r["rangeUpper"] = _num(r_upper[i])
        r["volMidQuote"] = _num(vq_m[i])
        r["volStdQuote"] = _num(vq_s[i])
        r["volMidBase"] = _num(vb_m[i])
        r["volStdBase"] = _num(vb_s[i])
        r["dAbsMidQuote"] = _num(dq_m[i])
        r["dAbsStdQuote"] = _num(dq_s[i])
        r["dAbsMidBase"] = _num(db_m[i])
        r["dAbsStdBase"] = _num(db_s[i])
        r["hh"] = bool(i > 0 and high[i] > high[i - 1])
        r["ll"] = bool(i > 0 and low[i] < low[i - 1])
    return rows
