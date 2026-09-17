"""Quant-style performance metrics from trades + equity curve."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Sequence

import numpy as np
import pandas as pd

from backend.engine.formatting import round_obj

# Category map used by UI / CSV headers
METRIC_CATEGORIES: dict[str, list[tuple[str, str]]] = {
    "Risk": [
        ("max_drawdown", "Max DD"),
        ("avg_mae", "Avg MAE"),
        ("ulcer_index", "Ulcer index"),
        ("downside_deviation", "Downside dev"),
        ("risk_of_ruin_proxy", "RoR proxy"),
        ("max_consec_losses", "Max consec losses"),
    ],
    "Trading": [
        ("trades", "Trades"),
        ("win_rate", "Win %"),
        ("expectancy", "Expectancy"),
        ("avg_win", "Avg win"),
        ("avg_loss", "Avg loss"),
        ("payoff_ratio", "Payoff"),
        ("max_consec_wins", "Max consec wins"),
        ("avg_mfe", "Avg MFE"),
        ("e_ratio", "E-ratio"),
        ("avg_ttmfe", "Avg tMFE"),
        ("avg_ttmae", "Avg tMAE"),
        ("avg_dt", "Avg ΔT"),
        ("pct_mae_first", "% MAE-first"),
        ("pct_mfe_first", "% MFE-first"),
    ],
    "Money management": [
        ("net_pnl", "Net PnL"),
        ("gross_profit", "Gross profit"),
        ("gross_loss", "Gross loss"),
        ("profit_factor", "Profit factor"),
        ("recovery_factor", "Recovery factor"),
        ("kelly_fraction", "Kelly %"),
        ("avg_trade", "Avg trade"),
    ],
    "Strategy": [
        ("sharpe", "Sharpe"),
        ("sortino", "Sortino"),
        ("calmar", "Calmar"),
        ("sqn", "SQN"),
        ("profit_factor", "Profit factor"),
        ("e_ratio", "E-ratio"),
        ("win_rate", "Win %"),
    ],
}


def _max_drawdown(equity: Sequence[float]) -> float:
    if not equity:
        return 0.0
    peak = equity[0]
    max_dd = 0.0
    for x in equity:
        peak = max(peak, x)
        dd = peak - x
        max_dd = max(max_dd, dd)
    return float(max_dd)


def _ulcer_index(equity: Sequence[float]) -> float:
    if len(equity) < 2:
        return 0.0
    peak = equity[0]
    sq = 0.0
    for x in equity:
        peak = max(peak, x)
        dd_pct = ((peak - x) / peak * 100.0) if peak > 1e-12 else 0.0
        sq += dd_pct * dd_pct
    return float(np.sqrt(sq / len(equity)))


def _streaks(pnls: Sequence[float]) -> tuple[int, int]:
    max_w = max_l = cur_w = cur_l = 0
    for p in pnls:
        if p > 0:
            cur_w += 1
            cur_l = 0
            max_w = max(max_w, cur_w)
        elif p < 0:
            cur_l += 1
            cur_w = 0
            max_l = max(max_l, cur_l)
        else:
            cur_w = cur_l = 0
    return max_w, max_l


def compute_trade_metrics(
    trades: Sequence[Any],
    equity_points: Sequence[dict[str, Any]] | None = None,
    *,
    bars_count: int = 0,
    tf_minutes: int = 15,
) -> dict[str, Any]:
    def g(t: Any, key: str, default: float = 0.0) -> float:
        if isinstance(t, dict):
            return float(t.get(key, default))
        return float(getattr(t, key, default))

    pnls = [g(t, "pnl") for t in trades]
    mfes = [g(t, "mfe") for t in trades]
    maes = [g(t, "mae") for t in trades]
    n = len(pnls)
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_win = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    net = float(sum(pnls)) if pnls else 0.0
    win_rate = (len(wins) / n * 100.0) if n else 0.0
    avg_win = float(np.mean(wins)) if wins else 0.0
    avg_loss = float(np.mean(losses)) if losses else 0.0
    profit_factor = (gross_win / gross_loss) if gross_loss > 1e-12 else (999.0 if gross_win > 0 else 0.0)
    expectancy = float(np.mean(pnls)) if pnls else 0.0
    payoff = (avg_win / abs(avg_loss)) if abs(avg_loss) > 1e-12 else (999.0 if avg_win > 0 else 0.0)
    avg_mfe = float(np.mean(mfes)) if mfes else 0.0
    avg_mae = float(np.mean(maes)) if maes else 0.0
    e_ratio = (avg_mfe / avg_mae) if avg_mae > 1e-12 else (999.0 if avg_mfe > 0 else 0.0)

    def _field(t: Any, key: str) -> Any:
        if isinstance(t, dict):
            return t.get(key)
        return getattr(t, key, None)

    def _as_dt(v: Any) -> datetime | None:
        if v is None:
            return None
        if isinstance(v, datetime):
            return v
        try:
            ts = pd.Timestamp(v)
        except (ValueError, TypeError):
            return None
        if pd.isna(ts):
            return None
        return ts.to_pydatetime()

    def _mins(later: Any, earlier: Any) -> float | None:
        a = _as_dt(later)
        b = _as_dt(earlier)
        if a is None or b is None:
            return None
        return max(0.0, (a - b).total_seconds() / 60.0)

    ttmfes: list[float] = []
    ttmaes: list[float] = []
    dts: list[float] = []
    mae_first = mfe_first = premature = giveback = momentum = 0
    timed = 0
    tf = max(int(tf_minutes or 1), 1)
    for t in trades:
        entry = _field(t, "entry_time")
        t_mfe = _mins(_field(t, "mfe_time"), entry)
        t_mae = _mins(_field(t, "mae_time"), entry)
        hold = _mins(_field(t, "exit_time"), entry) or 0.0
        if t_mfe is not None:
            ttmfes.append(t_mfe)
        if t_mae is not None:
            ttmaes.append(t_mae)
            if (t_mae / tf) <= 2.0 + 1e-9:
                premature += 1
        if t_mfe is not None and t_mae is not None:
            timed += 1
            dt = t_mfe - t_mae
            dts.append(dt)
            if dt > 1e-9:
                mae_first += 1
            elif dt < -1e-9:
                mfe_first += 1
                giveback += 1
        if t_mfe is not None and hold > 1e-9 and (t_mfe / hold) >= 0.70:
            momentum += 1

    n_mae = len(ttmaes)
    n_hold = n
    avg_ttmfe = float(np.mean(ttmfes)) if ttmfes else 0.0
    avg_ttmae = float(np.mean(ttmaes)) if ttmaes else 0.0
    avg_dt = float(np.mean(dts)) if dts else 0.0
    pct_mae_first = (100.0 * mae_first / timed) if timed else 0.0
    pct_mfe_first = (100.0 * mfe_first / timed) if timed else 0.0
    pct_premature = (100.0 * premature / n_mae) if n_mae else 0.0
    pct_giveback = (100.0 * giveback / timed) if timed else 0.0
    pct_momentum = (100.0 * momentum / n_hold) if n_hold else 0.0

    if equity_points:
        eq = [float(e["equity"]) for e in equity_points]
    else:
        eq = []
        running = 0.0
        for p in pnls:
            running += p
            eq.append(running)
    max_dd = _max_drawdown(eq)
    ulcer = _ulcer_index(eq)

    arr = np.array(pnls, dtype=float)
    if n >= 2 and float(arr.std(ddof=1)) > 1e-12:
        trades_per_year = 252.0 * (24 * 60 / max(tf_minutes, 1)) * (n / max(bars_count, 1))
        trades_per_year = float(np.clip(trades_per_year, 10.0, 50_000.0))
        sharpe = float(arr.mean() / arr.std(ddof=1) * np.sqrt(trades_per_year))
        downside = arr[arr < 0]
        dd_dev = float(downside.std(ddof=1)) if len(downside) >= 2 else 0.0
        if dd_dev != dd_dev:  # NaN guard
            dd_dev = 0.0
        if dd_dev > 1e-12:
            sortino = float(arr.mean() / dd_dev * np.sqrt(trades_per_year))
        else:
            sortino = 999.0 if arr.mean() > 0 else 0.0
        sqn = float(np.sqrt(n) * arr.mean() / arr.std(ddof=1))
        downside_deviation = dd_dev
    else:
        sharpe = 0.0
        sortino = 0.0
        sqn = 0.0
        downside_deviation = 0.0

    calmar = (net / max_dd) if max_dd > 1e-12 else (999.0 if net > 0 else 0.0)
    recovery = calmar
    max_w, max_l = _streaks(pnls)

    # Kelly fraction (edge / odds) using win rate and payoff
    wr = win_rate / 100.0
    if payoff > 1e-12:
        kelly = wr - (1.0 - wr) / payoff
    else:
        kelly = 0.0
    kelly = float(np.clip(kelly, -1.0, 1.0) * 100.0)

    # crude risk-of-ruin proxy: higher with more consec losses / lower win rate
    ror = float(min(100.0, (max_l / max(n, 1)) * (100.0 - win_rate)))

    flat = round_obj(
        {
            "trades": n,
            "net_pnl": net,
            "win_rate": win_rate,
            "gross_profit": gross_win,
            "gross_loss": -gross_loss,
            "profit_factor": profit_factor,
            "expectancy": expectancy,
            "avg_trade": expectancy,
            "avg_win": avg_win,
            "avg_loss": avg_loss,
            "payoff_ratio": payoff,
            "max_drawdown": max_dd,
            "ulcer_index": ulcer,
            "downside_deviation": downside_deviation,
            "sharpe": sharpe,
            "sortino": sortino,
            "calmar": calmar,
            "recovery_factor": recovery,
            "sqn": sqn,
            "avg_mfe": avg_mfe,
            "avg_mae": avg_mae,
            "e_ratio": e_ratio,
            "avg_ttmfe": avg_ttmfe,
            "avg_ttmae": avg_ttmae,
            "avg_dt": avg_dt,
            "pct_mae_first": pct_mae_first,
            "pct_mfe_first": pct_mfe_first,
            "pct_premature": pct_premature,
            "pct_giveback": pct_giveback,
            "pct_momentum": pct_momentum,
            "max_consec_wins": max_w,
            "max_consec_losses": max_l,
            "kelly_fraction": kelly,
            "risk_of_ruin_proxy": ror,
        }
    )
    flat["categories"] = {
        cat: {k: flat.get(k, 0) for k, _ in keys} for cat, keys in METRIC_CATEGORIES.items()
    }
    return flat
