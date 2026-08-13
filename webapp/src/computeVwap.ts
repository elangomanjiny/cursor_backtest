import type { BarRow } from './api'

export type VwapSource = 'hlc3' | 'ohlc4' | 'hl2' | 'close'
/** binance = reset daily at 05:30 IST (00:00 UTC); range = no reset */
export type VwapSession = 'binance' | 'range'

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

const BINANCE_SESSION_START_MIN = 5 * 60 + 30 // 05:30 IST

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

function istParts(timeSec: number) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timeSec * 1000))
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '0'
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    hh: Number(get('hour')),
    mm: Number(get('minute')),
  }
}

/**
 * Binance UM daily VWAP session key: anchors at 05:30 IST (= 00:00 UTC),
 * not midnight IST. Bars before 05:30 belong to the prior session.
 */
export function binanceSessionKey(timeSec: number): string {
  const p = istParts(timeSec)
  let y = p.y
  let m = p.m
  let d = p.d
  const mins = p.hh * 60 + p.mm
  if (mins < BINANCE_SESSION_START_MIN) {
    const dt = new Date(Date.UTC(y, m - 1, d))
    dt.setUTCDate(dt.getUTCDate() - 1)
    y = dt.getUTCFullYear()
    m = dt.getUTCMonth() + 1
    d = dt.getUTCDate()
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
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
  let prevSession = ''

  for (const b of bars) {
    if (settings.session === 'binance') {
      const sess = binanceSessionKey(b.time)
      if (sess !== prevSession) {
        sumV = 0
        sumPV = 0
        sumP2V = 0
        prevSession = sess
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
    for (const mult of bands) {
      bandMap[`up${mult}`] = vwap + mult * stdev
      bandMap[`dn${mult}`] = vwap - mult * stdev
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

/** Pro AGGR tags relative to LTP (prior bar close). */
export type AggrTag = 'Lo' | 'Sh' | 'Se' | 'Co'

export function classifyAggrTag(
  deltaPct: number,
  threshold: number,
  high: number,
  low: number,
  ltp: number,
): AggrTag | null {
  const thr = Math.abs(threshold)
  if (!(thr > 0) || !Number.isFinite(ltp)) return null
  if (deltaPct > thr) {
    if (high >= ltp) return 'Lo'
    if (low <= ltp) return 'Se'
    return null
  }
  if (deltaPct < -thr) {
    if (low <= ltp) return 'Sh'
    if (high >= ltp) return 'Co'
    return null
  }
  return null
}