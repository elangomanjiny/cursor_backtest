import type { BarRow } from './api'

export type VwapSource = 'hlc3' | 'ohlc4' | 'hl2' | 'close'
export type VwapSession = 'day' | 'range'

export type VwapSettings = {
  source: VwapSource
  session: VwapSession
  /** Std-dev band multipliers, e.g. [1, 2] */
  bands: number[]
}

export type VwapPoint = {
  time: number
  vwap: number
  stdev: number
  bands: Record<string, number>
}

function priceOf(b: BarRow, source: VwapSource): number {
  const o = Number(b.open)
  const h = Number(b.high)
  const l = Number(b.low)
  const c = Number(b.close)
  switch (source) {
    case 'ohlc4':
      return (o + h + l + c) / 4
    case 'hl2':
      return (h + l) / 2
    case 'close':
      return c
    case 'hlc3':
    default:
      return (h + l + c) / 3
  }
}

function volOf(b: BarRow, unit: 'quote' | 'base'): number {
  if (unit === 'base') return Math.max(0, Number(b.volume_base ?? 0))
  return Math.max(0, Number(b.volume_quote ?? b.volume ?? 0))
}

/** IST calendar day key YYYY-MM-DD for session reset. */
function istDayKey(timeSec: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timeSec * 1000))
}

/**
 * Anchored VWAP with volume-weighted standard deviation bands.
 * variance = Sum(v*p^2)/Sum(v) - vwap^2  (TradingView-style).
 */
export function computeVwap(
  bars: BarRow[],
  unit: 'quote' | 'base',
  settings: VwapSettings,
): VwapPoint[] {
  const bands = settings.bands.filter((n) => Number.isFinite(n) && n > 0)
  const out: VwapPoint[] = []
  let sumV = 0
  let sumPV = 0
  let sumP2V = 0
  let prevDay = ''

  for (const b of bars) {
    if (settings.session === 'day') {
      const day = istDayKey(b.time)
      if (day !== prevDay) {
        sumV = 0
        sumPV = 0
        sumP2V = 0
        prevDay = day
      }
    }

    const p = priceOf(b, settings.source)
    const v = volOf(b, unit)
    if (!(v > 0) || !Number.isFinite(p)) {
      if (out.length) {
        const last = out[out.length - 1]
        out.push({ ...last, time: b.time })
      }
      continue
    }

    sumV += v
    sumPV += p * v
    sumP2V += p * p * v
    const vwap = sumPV / sumV
    const variance = Math.max(0, sumP2V / sumV - vwap * vwap)
    const stdev = Math.sqrt(variance)
    const bandMap: Record<string, number> = {}
    for (const m of bands) {
      bandMap[`up${m}`] = vwap + m * stdev
      bandMap[`dn${m}`] = vwap - m * stdev
    }
    out.push({ time: b.time, vwap, stdev, bands: bandMap })
  }
  return out
}

export function parseBandMultipliers(raw: string): number[] {
  const parts = raw
    .split(/[,;\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  return [...new Set(parts.map((n) => Math.round(n * 100) / 100))].sort((a, b) => a - b)
}