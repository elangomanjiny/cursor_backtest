"""Quant-style performance metrics from trades + equity curve."""
from __future__ import annotations

from typing import Any, Sequence

import numpy as np

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
