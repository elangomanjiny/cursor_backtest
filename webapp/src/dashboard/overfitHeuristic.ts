import type { OptimizePoint } from '../api'

/** Heuristic overfit risk when true OOS Sharpe is unavailable. */
export function flagOverfitRisk(results: OptimizePoint[]): Set<string> {
  const flagged = new Set<string>()
  if (results.length < 4) return flagged

  const sharpes = results.map((r) => Number(r.sharpe ?? 0)).sort((a, b) => a - b)
  const trades = results.map((r) => Number(r.trades ?? 0)).sort((a, b) => a - b)
  const p75 = sharpes[Math.floor(sharpes.length * 0.75)] ?? 0
  const p90 = sharpes[Math.floor(sharpes.length * 0.9)] ?? 0
  const medTrades = trades[Math.floor(trades.length * 0.5)] ?? 0
  const dds = results.map((r) => Number(r.max_drawdown ?? 0))
  const medDd = [...dds].sort((a, b) => a - b)[Math.floor(dds.length * 0.5)] ?? 0

  for (const r of results) {
    const s = Number(r.sharpe ?? 0)
    const n = Number(r.trades ?? 0)
    const dd = Number(r.max_drawdown ?? 0)
    const key = comboKey(r)
    // High IS Sharpe with thin sample or outsized DD → overfit risk proxy
    if (s >= p75 && n < Math.max(3, medTrades * 0.5)) flagged.add(key)
    else if (s >= p90 && dd > medDd * 1.5 && medDd > 0) flagged.add(key)
  }
  return flagged
}

export function comboKey(r: {
  threshold: number
  rr: number
  wait_and_trade?: boolean
  pro_mode?: number | boolean
  pro_mtf_mode?: number | boolean
  base_tf?: number
  base_threshold?: number
  pro_vwap_sigma?: number
  break_even?: number
  break_even_pct?: number
  slippage_pct?: number
  fee_pct?: number
  volume?: number
  trail_stop?: number
  risk_on?: number
  trail_unit?: string
  trail_value?: number
  stop_loss?: number
  take_profit?: number
  sl_tp_unit?: string
  be_unit?: string
  be_value?: number
  entry_after?: number
  entry_before?: number
  exit_time?: number
}): string {
  const n = (v: unknown) => {
    const x = Number(v ?? 0)
    return Number.isFinite(x) ? String(x) : '0'
  }
  return [
    n(r.threshold),
    n(r.rr),
    r.wait_and_trade ? 1 : 0,
    r.pro_mode ? 1 : 0,
    r.pro_mtf_mode ? 1 : 0,
    n(r.base_tf),
    n(r.base_threshold),
    n(r.pro_vwap_sigma),
    n(r.break_even),
    n(r.break_even_pct),
    n(r.slippage_pct),
    n(r.fee_pct),
    n(r.volume),
    n(r.trail_stop),
    n(r.risk_on),
    n(r.stop_loss),
    n(r.take_profit),
    String(r.sl_tp_unit ?? ''),
    String(r.trail_unit ?? ''),
    n(r.trail_value),
    String(r.be_unit ?? ''),
    n(r.be_value),
    n(r.entry_after),
    n(r.entry_before),
    n(r.exit_time),
  ].join('|')
}
