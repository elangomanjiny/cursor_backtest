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
  break_even?: number
  break_even_pct?: number
  slippage_pct?: number
  fee_pct?: number
  entry_after?: number
  entry_before?: number
  exit_time?: number
}): string {
  return [
    r.threshold,
    r.rr,
    r.wait_and_trade ? 1 : 0,
    r.break_even ?? 0,
    r.break_even_pct ?? 0,
    r.slippage_pct ?? 0,
    r.fee_pct ?? 0,
    r.entry_after ?? 0,
    r.entry_before ?? 0,
    r.exit_time ?? 0,
  ].join('|')
}
