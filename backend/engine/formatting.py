"""Round numeric payloads to 2 decimal places for API/UI consistency."""
from __future__ import annotations

from typing import Any

SKIP_DEEP = frozenset({"levels", "developing"})

# Quote costs are tiny at 0.01 lots (e.g. 0.0037). 2-dp rounding showed 0.00.
COST_KEYS = frozenset({"fee", "slippage", "total_fees", "total_slippage"})


def r2(x: Any, *, ndigits: int = 2) -> Any:
    if isinstance(x, bool) or x is None:
        return x
    if isinstance(x, int) and not isinstance(x, bool):
        return x
    if isinstance(x, float):
        if x != x or x in (float("inf"), float("-inf")):  # NaN / Inf
            return 0.0
        return round(x, ndigits)
    # numpy scalars
    try:
        import numpy as np

        if isinstance(x, np.generic):
            return r2(x.item(), ndigits=ndigits)
    except Exception:
        pass
    return x


def round_obj(obj: Any, *, _key: str | None = None) -> Any:
    digits = 6 if _key in COST_KEYS else 2
    if isinstance(obj, float):
        return r2(obj, ndigits=digits)
    try:
        import numpy as np

        if isinstance(obj, np.generic):
            return r2(obj.item(), ndigits=digits)
    except Exception:
        pass
    if isinstance(obj, dict):
        return {
            k: v if k in SKIP_DEEP else round_obj(v, _key=k)
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [round_obj(v) for v in obj]
    if isinstance(obj, tuple):
        return tuple(round_obj(v) for v in obj)
    return obj
