"""Round numeric payloads to 2 decimal places for API/UI consistency."""
from __future__ import annotations

from typing import Any


def r2(x: Any) -> Any:
    if isinstance(x, bool) or x is None:
        return x
    if isinstance(x, int) and not isinstance(x, bool):
        return x
    if isinstance(x, float):
        if x != x or x in (float("inf"), float("-inf")):  # NaN / Inf
            return 0.0
        return round(x, 2)
    # numpy scalars
    try:
        import numpy as np

        if isinstance(x, np.generic):
            return r2(x.item())
    except Exception:
        pass
    return x


def round_obj(obj: Any) -> Any:
    if isinstance(obj, float):
        return r2(obj)
    try:
        import numpy as np

        if isinstance(obj, np.generic):
            return r2(obj.item())
    except Exception:
        pass
    if isinstance(obj, dict):
        return {k: round_obj(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [round_obj(v) for v in obj]
    if isinstance(obj, tuple):
        return tuple(round_obj(v) for v in obj)
    return obj
