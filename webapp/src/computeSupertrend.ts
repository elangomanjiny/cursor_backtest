/** Kivanc / TradingView SuperTrend (single line) and swing legs for STAVP. */

export type OhlcBar = {
  time: number
  high: number
  low: number
  close: number
}

export type SupertrendPoint = {
  time: number
  value: number
  trend: 1 | -1
}

export type SupertrendLeg = {
  /** Inclusive unix — lowest low of prior down-leg, or highest high of prior up-leg. */
  t0: number
  /** Exclusive unix (last bar + tf). */
  t1: number
  /** First SuperTrend candle of this phase (histogram left). */
  firstTime: number
  lastTime: number
  trend: 1 | -1
  startPrice: number
}

export type SupertrendResult = {
  points: SupertrendPoint[]
  legs: SupertrendLeg[]
}

function rmaAtr(bars: OhlcBar[], period: number): number[] {
  const n = bars.length
  const atr = new Array<number>(n).fill(NaN)
  if (n === 0 || period < 1) return atr
  const tr = new Array<number>(n)
  tr[0] = Math.max(0, bars[0].high - bars[0].low)
  for (let i = 1; i < n; i++) {
    const h = bars[i].high
    const l = bars[i].low
    const pc = bars[i - 1].close
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
  }
  if (n < period) return atr
  let sum = 0
  for (let i = 0; i < period; i++) sum += tr[i]
  let prev = sum / period
  atr[period - 1] = prev
  for (let i = period; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period
    atr[i] = prev
  }
  return atr
}

/**
 * Traditional SuperTrend (Kivanc Ozbilgic / TradingView Supertrend):
 * one line — green below price in an uptrend, red above price in a downtrend.
 * Flips when close crosses the previous band; the inactive band is not plotted.
 */
export function computeSupertrend(
  bars: OhlcBar[],
  period: number,
  multiplier: number,
  tfSec: number,
): SupertrendResult {
  const p = Math.max(1, Math.round(period) || 10)
  const factor = Math.max(0.1, Number(multiplier) || 3)
  const step = Math.max(1, Math.round(tfSec) || 60)
  const empty: SupertrendResult = { points: [], legs: [] }
  if (!bars.length) return empty

  const atr = rmaAtr(bars, p)
  const points: SupertrendPoint[] = []
  let prevUp = NaN
  let prevDn = NaN
  let trend: 1 | -1 = 1

  for (let i = 0; i < bars.length; i++) {
    const a = atr[i]
    if (!Number.isFinite(a)) continue
    const hl2 = (bars[i].high + bars[i].low) / 2
    let up = hl2 - factor * a
    let dn = hl2 + factor * a
    const close = bars[i].close
    const prevClose = i > 0 ? bars[i - 1].close : close
    if (Number.isFinite(prevUp) && prevClose > prevUp) up = Math.max(up, prevUp)
    if (Number.isFinite(prevDn) && prevClose < prevDn) dn = Math.min(dn, prevDn)
    if (Number.isFinite(prevDn) && close > prevDn) trend = 1
    else if (Number.isFinite(prevUp) && close < prevUp) trend = -1
    points.push({ time: bars[i].time, value: trend === 1 ? up : dn, trend })
    prevUp = up
    prevDn = dn
  }

  return { points, legs: legsFromPoints(bars, points, step) }
}

function legsFromPoints(bars: OhlcBar[], points: SupertrendPoint[], tfSec: number): SupertrendLeg[] {
  if (!points.length) return []
  const byTime = new Map<number, OhlcBar>()
  for (const b of bars) byTime.set(b.time, b)

  type Group = { trend: 1 | -1; times: number[] }
  const groups: Group[] = []
  let cur: Group | null = null
  for (const p of points) {
    if (!cur || cur.trend !== p.trend) {
      cur = { trend: p.trend, times: [p.time] }
      groups.push(cur)
    } else {
      cur.times.push(p.time)
    }
  }

  const extreme = (times: number[], wantLow: boolean): { time: number; price: number } => {
    let bestT = times[0]
    let best = wantLow ? Infinity : -Infinity
    for (const t of times) {
      const b = byTime.get(t)
      if (!b) continue
      const v = wantLow ? b.low : b.high
      if (wantLow ? v < best : v > best) {
        best = v
        bestT = t
      }
    }
    return { time: bestT, price: Number.isFinite(best) ? best : byTime.get(bestT)?.close ?? 0 }
  }

  const legs: SupertrendLeg[] = []
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const firstTime = g.times[0]
    const lastTime = g.times[g.times.length - 1]
    const first = byTime.get(firstTime)
    let t0 = firstTime
    let startPrice = g.trend === 1 ? (first?.low ?? 0) : (first?.high ?? 0)
    if (i > 0) {
      const prev = groups[i - 1]
      const ex = extreme(prev.times, g.trend === 1)
      t0 = ex.time
      startPrice = ex.price
    }
    legs.push({
      t0,
      t1: lastTime + tfSec,
      firstTime,
      lastTime,
      trend: g.trend,
      startPrice,
    })
  }
  return legs
}
