"""Host resource snapshot for optimize capacity warnings."""
from __future__ import annotations

from typing import Any


def _via_psutil() -> dict[str, Any] | None:
    try:
        import psutil
    except ImportError:
        return None
    mem = psutil.virtual_memory()
    # Non-blocking; first call may be 0.0 until the next sample.
    cpu = float(psutil.cpu_percent(interval=0.0))
    return {
        "ram_used_bytes": int(mem.used),
        "ram_total_bytes": int(mem.total),
        "ram_available_bytes": int(mem.available),
        "ram_percent": round(float(mem.percent), 1),
        "cpu_percent": round(cpu, 1),
        "source": "psutil",
    }


def _via_ctypes_windows() -> dict[str, Any] | None:
    try:
        import ctypes
        from ctypes import wintypes
    except ImportError:
        return None

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", wintypes.DWORD),
            ("dwMemoryLoad", wintypes.DWORD),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    stat = MEMORYSTATUSEX()
    stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
        return None
    used = int(stat.ullTotalPhys - stat.ullAvailPhys)
    return {
        "ram_used_bytes": used,
        "ram_total_bytes": int(stat.ullTotalPhys),
        "ram_available_bytes": int(stat.ullAvailPhys),
        "ram_percent": round(float(stat.dwMemoryLoad), 1),
        "cpu_percent": None,
        "source": "ctypes",
    }


def get_system_resources() -> dict[str, Any]:
    """Return RAM (and CPU when available) with warn level for the UI strip."""
    snap = _via_psutil() or _via_ctypes_windows()
    if snap is None:
        return {
            "ok": False,
            "ram_percent": None,
            "warn_level": "unknown",
            "message": "Resource metrics unavailable",
        }

    pct = float(snap["ram_percent"])
    if pct >= 90:
        level = "red"
        message = "RAM critical — drop workers or cancel to avoid crash"
    elif pct >= 80:
        level = "amber"
        message = "RAM high — consider fewer workers"
    else:
        level = "ok"
        message = "RAM OK"

    return {
        "ok": True,
        "warn_level": level,
        "message": message,
        **snap,
    }
