import type { TradeRow } from '../api'

export type ExcursionSeq = 'MAE→' | 'MFE→' | 'same' | 'MAE' | 'MFE' | '—'

export type TradeExcursionTiming = {
  tMfeMin: number | null
  tMaeMin: number | null
  tMfeBars: number | null
  tMaeBars: number | null
  dtMin: number | null
  holdMin: number
  tMfePct: number | null
  seq: ExcursionSeq
  premature: boolean
  giveback: boolean
  momentum: boolean
}

function toUnix(iso: string | null | undefined): number {
  if (!iso) return 0
  const t = Math.floor(new Date(iso).getTime() / 1000)
  return Number.isFinite(t) ? t : 0
}

function minsBetween(later: string | null | undefined, earlier: string): number | null {
  if (!later) return null
  const a = toUnix(later)
  const b = toUnix(earlier)
  if (!a || !b) return null
  return Math.max(0, (a - b) / 60)
}

export function tradeExcursionTiming(
  t: Pick<TradeRow, 'entry_time' | 'exit_time' | 'mfe_time' | 'mae_time'>,
  tfMinutes: number,
): TradeExcursionTiming {
  const tf = Math.max(Number(tfMinutes) || 1, 1)
  const holdMin = minsBetween(t.exit_time, t.entry_time) ?? 0
  const tMfeMin = minsBetween(t.mfe_time, t.entry_time)
  const tMaeMin = minsBetween(t.mae_time, t.entry_time)
  const tMfeBars = tMfeMin == null ? null : tMfeMin / tf
  const tMaeBars = tMaeMin == null ? null : tMaeMin / tf
  const dtMin = tMfeMin != null && tMaeMin != null ? tMfeMin - tMaeMin : null
  const tMfePct = tMfeMin != null && holdMin > 1e-9 ? (100 * tMfeMin) / holdMin : null

  let seq: ExcursionSeq = '—'
  if (tMfeMin != null && tMaeMin != null) {
    if (dtMin != null && dtMin > 1e-6) seq = 'MAE→'
    else if (dtMin != null && dtMin < -1e-6) seq = 'MFE→'
    else seq = 'same'
  } else if (tMaeMin != null) seq = 'MAE'
  else if (tMfeMin != null) seq = 'MFE'

  return {
    tMfeMin,
    tMaeMin,
    tMfeBars,
    tMaeBars,
    dtMin,
    holdMin,
    tMfePct,
    seq,
    premature: tMaeBars != null && tMaeBars <= 2 + 1e-9,
    giveback: dtMin != null && dtMin < -1e-6,
    momentum: tMfePct != null && tMfePct >= 70,
  }
}

export type ExcursionTimingStats = {
  avgTmfe: number
  avgTmae: number
  avgDt: number
  pctMaeFirst: number
  pctMfeFirst: number
  pctPremature: number
  pctGiveback: number
  pctMomentum: number
  timed: number
}

export function summarizeExcursionTiming(
  trades: Array<Pick<TradeRow, 'entry_time' | 'exit_time' | 'mfe_time' | 'mae_time'>>,
  tfMinutes: number,
): ExcursionTimingStats {
  if (!trades.length) {
    return {
      avgTmfe: 0,
      avgTmae: 0,
      avgDt: 0,
      pctMaeFirst: 0,
      pctMfeFirst: 0,
      pctPremature: 0,
      pctGiveback: 0,
      pctMomentum: 0,
      timed: 0,
    }
  }
  const rows = trades.map((t) => tradeExcursionTiming(t, tfMinutes))
  const mfes = rows.map((r) => r.tMfeMin).filter((n): n is number => n != null)
  const maes = rows.map((r) => r.tMaeMin).filter((n): n is number => n != null)
  const dts = rows.map((r) => r.dtMin).filter((n): n is number => n != null)
  const timed = dts.length
  const maeFirst = rows.filter((r) => r.dtMin != null && r.dtMin > 1e-6).length
  const mfeFirst = rows.filter((r) => r.giveback).length
  const premature = rows.filter((r) => r.premature).length
  const momentum = rows.filter((r) => r.momentum).length
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  return {
    avgTmfe: mean(mfes),
    avgTmae: mean(maes),
    avgDt: mean(dts),
    pctMaeFirst: timed ? (100 * maeFirst) / timed : 0,
    pctMfeFirst: timed ? (100 * mfeFirst) / timed : 0,
    pctPremature: maes.length ? (100 * premature) / maes.length : 0,
    pctGiveback: timed ? (100 * mfeFirst) / timed : 0,
    pctMomentum: (100 * momentum) / trades.length,
    timed,
  }
}

export function fmtMinsBars(minutes: number | null, bars: number | null): string {
  if (minutes == null || bars == null) return '—'
  const m = minutes < 10 ? minutes.toFixed(1) : minutes.toFixed(0)
  const b = bars < 10 ? bars.toFixed(1) : bars.toFixed(0)
  return `${m}m / ${b}b`
}
