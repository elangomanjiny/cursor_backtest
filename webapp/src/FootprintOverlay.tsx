import { useEffect, useRef, useState, type RefObject } from 'react'
import type { IChartApi } from '@stocksharp/chart'
import { clipPlotCanvases, priceScaleGutter } from './chartPricePan'
import {
  fetchAnchoredProfile,
  fetchAnchoredProfiles,
  fetchFlowStats,
  fetchFootprint,
  fetchValueArea,
  type AnchoredProfile,
  type AnchoredVaPoint,
  type FootprintBar,
  type FootprintLevel,
} from './api'
import type { SupertrendLeg, SupertrendPoint } from './computeSupertrend'

export type CandleSeries = {
  priceToCoordinate: (price: number) => number | null
  applyOptions: (opts: Record<string, unknown>) => void
}

export type FootprintMode = 'profile' | 'bidask' | 'delta' | 'volume'

export type StavpPlace = 'swings' | 'lastCandle'

export type StavpProfileRow = {
  t0: number
  t1: number
  lastTime: number
  trend: 1 | -1
  vah?: number | null
  poc?: number | null
  val?: number | null
  vahBase?: number | null
  pocBase?: number | null
  valBase?: number | null
  developing?: AnchoredVaPoint[]
}

export const STAVP_MAX_LEGS = 8

/** Need wide bars so profile cells are readable. */
export const FOOTPRINT_MIN_BAR_PX = 24
export const FOOTPRINT_MAX_BARS = 64
export const VAZ_MAX_BARS = 512
export const FLOW_MAX_BARS = 512

type Unit = 'quote' | 'base'

export type OfSignalBar = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  delta: number
  range?: number | null
  rangeUpper?: number | null
  volMid?: number | null
  volStd?: number | null
  dAbsMid?: number | null
  dAbsStd?: number | null
  hh?: boolean
  ll?: boolean
}

type Props = {
  chartRef: RefObject<IChartApi | null>
  seriesRef: RefObject<CandleSeries | null>
  wrapRef: RefObject<HTMLDivElement | null>
  chartEpoch: number
  show: boolean
  showVaz: boolean
  showCot: boolean
  showMinMax: boolean
  showVp?: boolean
  vpMode?: FootprintMode
  vpBinMult?: number
  vazBinMult?: number
  vpT0?: number | null
  vpT1?: number | null
  showStavp?: boolean
  stavpMode?: FootprintMode
  stavpBinMult?: number
  stavpWidthPct?: number
  stavpPlace?: StavpPlace
  stavpLegs?: SupertrendLeg[]
  stavpPoints?: SupertrendPoint[]
  onStavpProfiles?: (rows: StavpProfileRow[]) => void
  showIdhl?: boolean
  guides?: { time: number; high: number; low: number }[]
  ofBars?: OfSignalBar[]
  showImb?: boolean
  showDiv?: boolean
  showAbsorb?: boolean
  absorbMode?: 'body' | 'range' | 'extreme'
  absorbBodyPct?: number
  showUa?: boolean
  showBigVol?: boolean
  showBigAsk?: boolean
  showBigBid?: boolean
  imbRatio?: number
  imbConsec?: number
  imbIgnoreZero?: boolean
  imbMode?: 'diagonal' | 'horizontal'
  bigMult?: number
  symbol: string
  tf: number
  unit: Unit
  mode: FootprintMode
  binMult: number
  barTimes: number[]
  onVazBars?: (bars: FootprintBar[]) => void
}

function volOf(bar: FootprintLevel, unit: Unit, side: 'bid' | 'ask') {
  if (unit === 'quote') return side === 'bid' ? bar.bidQuote : bar.askQuote
  return side === 'bid' ? bar.bidVolume : bar.askVolume
}

function fmtVol(v: number): string {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}m`
  if (a >= 1000) return `${(v / 1000).toFixed(1)}k`
  if (a >= 10) return v.toFixed(0)
  if (a >= 1) return v.toFixed(1)
  return v.toFixed(2)
}

function fmtDelta(v: number): string {
  const s = fmtVol(v)
  return v > 0 ? `+${s}` : s
}

const COL = {
  vol: 'rgba(88,166,255,0.48)',
  poc: '#f0b429',
  goldDash: '#f0b429',
  cyanDash: '#22d3ee',
  vaz: 'rgba(240,180,41,0.22)',
  vazLine: 'rgba(240,180,41,0.45)',
  pos: 'rgba(63,185,80,0.48)',
  neg: 'rgba(248,81,73,0.48)',
  posTxt: '#3fb950',
  negTxt: '#f85149',
  bid: 'rgba(248,81,73,0.48)',
  ask: 'rgba(63,185,80,0.48)',
  text: 'rgba(240,246,252,0.95)',
  pill: 'rgba(13,17,23,0.72)',
}

function profileW(v: number, maxV: number, maxPx: number): number {
  if (v <= 0 || maxV <= 0 || maxPx <= 0) return 0
  return Math.max(2, (v / maxV) * maxPx)
}

function hbar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
) {
  if (w < 0.5 || h < 0.5) return
  ctx.fillStyle = fill
  const r = Math.min(2, h * 0.35, Math.abs(w) * 0.35)
  if (typeof ctx.roundRect === 'function' && r >= 0.8) {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
    ctx.fill()
  } else {
    ctx.fillRect(x, y, w, h)
  }
}

function pocStroke(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  if (w < 1 || h < 1) return
  ctx.strokeStyle = COL.poc
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1))
}

function drawSpine(ctx: CanvasRenderingContext2D, series: CandleSeries, bar: FootprintBar, mid: number) {
  const yH = series.priceToCoordinate(bar.high)
  const yL = series.priceToCoordinate(bar.low)
  const yO = series.priceToCoordinate(bar.open)
  const yC = series.priceToCoordinate(bar.close)
  if (yH == null || yL == null) return
  const up = bar.close >= bar.open
  ctx.strokeStyle = up ? '#3fb950' : '#f85149'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(mid, yH)
  ctx.lineTo(mid, yL)
  ctx.stroke()
  if (yO == null || yC == null) return
  const top = Math.min(yO, yC)
  const bh = Math.max(2, Math.abs(yC - yO))
  ctx.fillStyle = up ? '#3fb950' : '#f85149'
  ctx.fillRect(mid - 1.25, top, 2.5, bh)
}

function flowOf(bar: FootprintBar, unit: Unit) {
  if (unit === 'quote') {
    return {
      minD: bar.minDeltaQuote,
      maxD: bar.maxDeltaQuote,
      ch: bar.cotHighQuote,
      cl: bar.cotLowQuote,
    }
  }
  return {
    minD: bar.minDelta,
    maxD: bar.maxDelta,
    ch: bar.cotHigh,
    cl: bar.cotLow,
  }
}

type FlowKind = 'ch' | 'cl' | 'max' | 'min'

function dashAlert(kind: FlowKind, v: number): boolean {
  if (kind === 'ch') return v > 0
  if (kind === 'cl') return v < 0
  return Number.isFinite(v) && Math.abs(v) < 10
}

function drawSignedPill(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  v: number,
  kind: FlowKind,
) {
  const w = ctx.measureText(text).width
  const rx = x - w / 2 - 3
  const ry = y - 6
  const rw = w + 6
  const rh = 12
  ctx.fillStyle = COL.pill
  ctx.fillRect(rx, ry, rw, rh)
  const ink = v >= 0 ? COL.posTxt : COL.negTxt
  if (dashAlert(kind, v)) {
    ctx.strokeStyle = kind === 'ch' || kind === 'cl' ? COL.goldDash : COL.cyanDash
    ctx.lineWidth = 1.5
    ctx.setLineDash([3, 2])
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1)
    ctx.setLineDash([])
  }
  ctx.fillStyle = ink
  ctx.textAlign = 'center'
  ctx.fillText(text, x, y)
}

function barSlot(chart: IChartApi, time: number, tfSec: number) {
  const ts = chart.timeScale()
  const mid = ts.timeToCoordinate(time as never)
  if (mid == null) return null
  const next = ts.timeToCoordinate((time + tfSec) as never)
  const prev = ts.timeToCoordinate((time - tfSec) as never)
  let spacing = 8
  if (next != null && next > mid) spacing = next - mid
  else if (prev != null && mid > prev) spacing = mid - prev
  const bw = Math.max(4, spacing - 1)
  return { mid, x0: mid - bw / 2, bw }
}

function drawFlowLabels(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: CandleSeries,
  bars: FootprintBar[],
  tfSec: number,
  unit: Unit,
  showCot: boolean,
  showMinMax: boolean,
  h: number,
) {
  if (!showCot && !showMinMax) return
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  for (const bar of bars) {
    const f = flowOf(bar, unit)
    const slot = barSlot(chart, bar.time, tfSec)
    if (!slot) continue
    const { mid, bw } = slot
    if (bw < 6) continue
    const compact = bw < 28
    const yH = series.priceToCoordinate(bar.high)
    const yL = series.priceToCoordinate(bar.low)
    if (yH == null || yL == null) continue
    ctx.font = compact
      ? '9px ui-sans-serif, system-ui, sans-serif'
      : '10px ui-sans-serif, system-ui, sans-serif'
    const gap = Math.max(10, bw * 0.28)
    const above = yH - 8
    const below = yL + 8
    const maxTxt =
      showMinMax && f.maxD != null && Number.isFinite(f.maxD)
        ? compact
          ? fmtDelta(f.maxD)
          : `Max ${fmtDelta(f.maxD)}`
        : null
    const chTxt =
      showCot && f.ch != null && Number.isFinite(f.ch)
        ? compact
          ? fmtDelta(f.ch)
          : `CH ${fmtDelta(f.ch)}`
        : null
    const minTxt =
      showMinMax && f.minD != null && Number.isFinite(f.minD)
        ? compact
          ? fmtDelta(f.minD)
          : `Min ${fmtDelta(f.minD)}`
        : null
    const clTxt =
      showCot && f.cl != null && Number.isFinite(f.cl)
        ? compact
          ? fmtDelta(f.cl)
          : `CL ${fmtDelta(f.cl)}`
        : null
    if (above > 4 && above < h - 4) {
      if (maxTxt && chTxt) {
        drawSignedPill(ctx, maxTxt, mid - gap, above, f.maxD as number, 'max')
        drawSignedPill(ctx, chTxt, mid + gap, above, f.ch as number, 'ch')
      } else if (maxTxt) {
        drawSignedPill(ctx, maxTxt, mid, above, f.maxD as number, 'max')
      } else if (chTxt) {
        drawSignedPill(ctx, chTxt, mid, above, f.ch as number, 'ch')
      }
    }
    if (below > 4 && below < h - 4) {
      if (minTxt && clTxt) {
        drawSignedPill(ctx, minTxt, mid - gap, below, f.minD as number, 'min')
        drawSignedPill(ctx, clTxt, mid + gap, below, f.cl as number, 'cl')
      } else if (minTxt) {
        drawSignedPill(ctx, minTxt, mid, below, f.minD as number, 'min')
      } else if (clTxt) {
        drawSignedPill(ctx, clTxt, mid, below, f.cl as number, 'cl')
      }
    }
  }
}

function vazOf(bar: FootprintBar, unit: Unit): { val: number; poc: number; vah: number } | null {
  const val = unit === 'quote' ? bar.val : (bar.valBase ?? bar.val)
  const vah = unit === 'quote' ? bar.vah : (bar.vahBase ?? bar.vah)
  const poc = unit === 'quote' ? bar.poc : (bar.pocBase ?? bar.poc)
  if (val == null || vah == null || !Number.isFinite(val) || !Number.isFinite(vah)) return null
  const lo = Math.min(val, vah)
  const hi = Math.max(val, vah)
  const mid = poc != null && Number.isFinite(poc) ? Number(poc) : (lo + hi) / 2
  return { val: lo, poc: mid, vah: hi }
}

type StairSeg = { x0: number; x1: number; y: number }

function strokeStairs(
  ctx: CanvasRenderingContext2D,
  segs: StairSeg[],
  color: string,
  width: number,
) {
  if (!segs.length) return
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineJoin = 'miter'
  ctx.lineCap = 'butt'
  ctx.beginPath()
  ctx.moveTo(segs[0].x0, segs[0].y)
  for (let i = 0; i < segs.length; i++) {
    ctx.lineTo(segs[i].x1, segs[i].y)
    if (i + 1 < segs.length) ctx.lineTo(segs[i].x1, segs[i + 1].y)
  }
  ctx.stroke()
}

function fillStairsBand(
  ctx: CanvasRenderingContext2D,
  top: StairSeg[],
  bot: StairSeg[],
  color: string,
) {
  if (!top.length || !bot.length) return
  ctx.beginPath()
  ctx.moveTo(top[0].x0, top[0].y)
  for (let i = 0; i < top.length; i++) {
    ctx.lineTo(top[i].x1, top[i].y)
    if (i + 1 < top.length) ctx.lineTo(top[i].x1, top[i + 1].y)
  }
  const last = bot[bot.length - 1]
  ctx.lineTo(last.x1, last.y)
  for (let i = bot.length - 1; i >= 0; i--) {
    ctx.lineTo(bot[i].x0, bot[i].y)
    if (i > 0) ctx.lineTo(bot[i].x0, bot[i - 1].y)
  }
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

function drawVaz(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: CandleSeries,
  bars: FootprintBar[],
  _tick: number,
  tfSec: number,
  unit: Unit,
  h: number,
) {
  const ordered = [...bars].sort((a, b) => a.time - b.time)
  const vah: StairSeg[] = []
  const poc: StairSeg[] = []
  const val: StairSeg[] = []
  for (const bar of ordered) {
    const za = vazOf(bar, unit)
    if (!za) continue
    const slot = barSlot(chart, bar.time, tfSec)
    if (!slot) continue
    const yVah = series.priceToCoordinate(za.vah)
    const yPoc = series.priceToCoordinate(za.poc)
    const yVal = series.priceToCoordinate(za.val)
    if (yVah == null || yPoc == null || yVal == null) continue
    if (yVah < -40 && yVal < -40) continue
    if (yVah > h + 40 && yVal > h + 40) continue
    const x0 = slot.x0
    const x1 = slot.x0 + slot.bw
    vah.push({ x0, x1, y: yVah })
    poc.push({ x0, x1, y: yPoc })
    val.push({ x0, x1, y: yVal })
  }
  if (!vah.length) return
  fillStairsBand(ctx, vah, val, 'rgba(240, 180, 41, 0.10)')
  strokeStairs(ctx, vah, '#f0b429', 1.6)
  strokeStairs(ctx, poc, '#ffe08a', 2)
  strokeStairs(ctx, val, '#58a6ff', 1.6)
  const last = vah[vah.length - 1]
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#f0b429'
  ctx.fillText('VAH', last.x1 + 6, vah[vah.length - 1].y)
  ctx.fillStyle = '#ffe08a'
  ctx.fillText('POC', last.x1 + 6, poc[poc.length - 1].y)
  ctx.fillStyle = '#58a6ff'
  ctx.fillText('VAL', last.x1 + 6, val[val.length - 1].y)
}

function utcDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

function drawDaySeps(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  times: number[],
  h: number,
) {
  ctx.save()
  ctx.setLineDash([5, 4])
  ctx.strokeStyle = '#d2a8ff99'
  ctx.lineWidth = 1
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.fillStyle = '#d2a8ff'
  ctx.textAlign = 'left'
  let prev = ''
  for (const t of times) {
    const d = utcDay(t)
    if (d === prev) continue
    prev = d
    const x = chart.timeScale().timeToCoordinate(t as never)
    if (x == null || x < -8 || x > ctx.canvas.clientWidth + 8) continue
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  ctx.restore()
}

function drawIdhl(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: CandleSeries,
  bars: { time: number; high: number; low: number }[],
  tfSec: number,
) {
  let day = ''
  let hi = -Infinity
  let lo = Infinity
  const hiSegs: StairSeg[] = []
  const loSegs: StairSeg[] = []
  for (const b of bars) {
    const d = utcDay(b.time)
    if (d !== day) {
      day = d
      hi = b.high
      lo = b.low
    } else {
      if (b.high > hi) hi = b.high
      if (b.low < lo) lo = b.low
    }
    const slot = barSlot(chart, b.time, tfSec)
    if (!slot) continue
    const yH = series.priceToCoordinate(hi)
    const yL = series.priceToCoordinate(lo)
    if (yH != null) hiSegs.push({ x0: slot.x0, x1: slot.x0 + slot.bw, y: yH })
    if (yL != null) loSegs.push({ x0: slot.x0, x1: slot.x0 + slot.bw, y: yL })
  }
  if (!hiSegs.length) return
  strokeStairs(ctx, hiSegs, '#3fb950cc', 1.3)
  strokeStairs(ctx, loSegs, '#f85149cc', 1.3)
  const lastH = hiSegs[hiSegs.length - 1]
  const lastL = loSegs[loSegs.length - 1]
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#3fb950'
  ctx.fillText('IDH', lastH.x1 + 6, lastH.y)
  ctx.fillStyle = '#f85149'
  ctx.fillText('IDL', lastL.x1 + 6, lastL.y)
}

function drawVpRangeMarks(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  t0: number | null | undefined,
  t1: number | null | undefined,
  h: number,
) {
  ctx.save()
  ctx.setLineDash([4, 3])
  ctx.strokeStyle = '#a371f7'
  ctx.lineWidth = 1.4
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  const marks: { t: number; lab: string }[] = []
  if (t0 != null && Number.isFinite(t0)) marks.push({ t: t0, lab: 'VP start' })
  if (t1 != null && Number.isFinite(t1) && t1 !== t0) marks.push({ t: t1, lab: 'VP end' })
  for (const m of marks) {
    const x = chart.timeScale().timeToCoordinate(m.t as never)
    if (x == null) continue
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
    ctx.fillStyle = '#a371f7'
    ctx.fillText(m.lab, x, 12)
  }
  ctx.restore()
}

export type OfSigFlags = {
  imb: boolean
  div: boolean
  absorb: boolean
  absorbMode: 'body' | 'range' | 'extreme'
  absorbBodyPct: number
  ua: boolean
  bigVol: boolean
  bigAsk: boolean
  bigBid: boolean
  imbRatio: number
  imbConsec: number
  imbIgnoreZero: boolean
  imbMode: 'diagonal' | 'horizontal'
  bigMult: number
}

function markTri(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: 1 | -1,
  color: string,
) {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - 4, y + dir * 8)
  ctx.lineTo(x + 4, y + dir * 8)
  ctx.closePath()
  ctx.fill()
}

function markBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  fill: string,
  stroke: string,
) {
  const r = Math.max(3.5, Math.min(14, radius))
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1.2
  ctx.stroke()
}

function levelTot(lv: FootprintLevel, unit: Unit): number {
  return volOf(lv, unit, 'ask') + volOf(lv, unit, 'bid')
}

function levelDelta(lv: FootprintLevel, unit: Unit): number {
  return volOf(lv, unit, 'ask') - volOf(lv, unit, 'bid')
}

function pickMaxLevel(
  levels: FootprintLevel[],
  score: (lv: FootprintLevel) => number,
): FootprintLevel | null {
  let best: FootprintLevel | null = null
  let bestV = 0
  for (const lv of levels) {
    const v = score(lv)
    if (v > bestV) {
      bestV = v
      best = lv
    }
  }
  return bestV > 0 ? best : null
}

function bubbleRadius(v: number, maxV: number, bw: number): number {
  if (v <= 0 || maxV <= 0) return 5
  return 4 + (v / maxV) * Math.min(12, Math.max(6, bw * 0.38))
}

function sigmaHigh(x: number, mid: number | null | undefined, std: number | null | undefined, k: number): boolean {
  if (mid == null || std == null || !Number.isFinite(mid) || !Number.isFinite(std)) return false
  return x > mid + k * std
}

function rangeInBand(rng: number | null | undefined, upper: number | null | undefined): boolean {
  if (rng == null || upper == null || !Number.isFinite(rng) || !Number.isFinite(upper)) return false
  return rng <= upper
}

function classifyImb(num: number, den: number, ratio: number, ignoreZero: boolean): boolean {
  if (num <= 0) return false
  if (den <= 0) return !ignoreZero
  return num / den >= ratio
}

function markUa(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  lab: string,
) {
  ctx.fillStyle = color
  ctx.fillRect(x - 5, y - 5, 10, 10)
  ctx.strokeStyle = '#0d1117'
  ctx.lineWidth = 1
  ctx.strokeRect(x - 5, y - 5, 10, 10)
  ctx.font = '9px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = color
  ctx.fillText(lab, x, y - 12)
}

function drawImbalanceMarks(
  ctx: CanvasRenderingContext2D,
  series: CandleSeries,
  levels: FootprintLevel[],
  slot: { x0: number; bw: number },
  unit: Unit,
  h: number,
  sigs: OfSigFlags,
) {
  const n = levels.length
  if (n < 1) return
  const ratio = Math.max(1.5, sigs.imbRatio || 3)
  const need = Math.max(1, Math.round(sigs.imbConsec || 1))
  const ignoreZero = sigs.imbIgnoreZero !== false
  const askImb = new Array<boolean>(n).fill(false)
  const bidImb = new Array<boolean>(n).fill(false)
  if (sigs.imbMode === 'horizontal') {
    for (let k = 0; k < n; k++) {
      const ask = volOf(levels[k], unit, 'ask')
      const bid = volOf(levels[k], unit, 'bid')
      askImb[k] = classifyImb(ask, bid, ratio, ignoreZero)
      bidImb[k] = classifyImb(bid, ask, ratio, ignoreZero)
    }
  } else {
    for (let k = 1; k < n; k++) {
      const askUp = volOf(levels[k], unit, 'ask')
      const bidDn = volOf(levels[k - 1], unit, 'bid')
      askImb[k] = classifyImb(askUp, bidDn, ratio, ignoreZero)
      bidImb[k - 1] = classifyImb(bidDn, askUp, ratio, ignoreZero)
    }
  }
  const paintRun = (flags: boolean[], side: 'ask' | 'bid') => {
    let i = 0
    while (i < n) {
      if (!flags[i]) {
        i += 1
        continue
      }
      let j = i
      while (j < n && flags[j]) j += 1
      if (j - i >= need) {
        for (let k = i; k < j; k++) {
          const y = series.priceToCoordinate(levels[k].price)
          if (y == null || y < 0 || y > h) continue
          ctx.fillStyle = side === 'ask' ? '#3fb950' : '#f85149'
          const x = side === 'ask' ? slot.x0 + slot.bw - 4 : slot.x0
          ctx.fillRect(x, y - 2, 4, 4)
        }
      }
      i = j
    }
  }
  paintRun(askImb, 'ask')
  paintRun(bidImb, 'bid')
}

function drawOfSignals(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: CandleSeries,
  fpBars: FootprintBar[],
  ofBars: OfSignalBar[],
  tfSec: number,
  unit: Unit,
  h: number,
  sigs: OfSigFlags,
) {
  const fpBy = new Map(fpBars.map((b) => [b.time, b]))
  const n = ofBars.length
  const k = Math.max(0.5, sigs.bigMult || 1)
  for (let i = 0; i < n; i++) {
    const b = ofBars[i]
    const slot = barSlot(chart, b.time, tfSec)
    if (!slot) continue
    const yH = series.priceToCoordinate(b.high)
    const yL = series.priceToCoordinate(b.low)
    if (yH == null || yL == null) continue
    const fp = fpBy.get(b.time)
    const levels = [...(fp?.levels ?? [])].sort((a, c) => a.price - c.price)
    const maxLv = Math.max(1, ...levels.map((lv) => levelTot(lv, unit)))

    const paintAt = (price: number, vol: number, fill: string, stroke: string) => {
      const y = series.priceToCoordinate(price)
      if (y == null) return false
      markBubble(ctx, slot.mid, y, bubbleRadius(vol, maxLv, slot.bw), fill, stroke)
      return true
    }

    if (sigs.bigVol && sigmaHigh(b.volume, b.volMid, b.volStd, k)) {
      const lv = pickMaxLevel(levels, (x) => levelTot(x, unit))
      if (!lv || !paintAt(lv.price, levelTot(lv, unit), 'rgba(88,166,255,0.42)', '#58a6ff')) {
        markTri(ctx, slot.mid, yL + 10, 1, '#58a6ff')
      }
    }
    if (sigs.bigAsk && b.delta > 0 && sigmaHigh(b.delta, b.dAbsMid, b.dAbsStd, k)) {
      const lv = pickMaxLevel(levels, (x) => volOf(x, unit, 'ask'))
      if (!lv || !paintAt(lv.price, volOf(lv, unit, 'ask'), 'rgba(63,185,80,0.42)', '#3fb950')) {
        markTri(ctx, slot.mid + 6, yH - 10, -1, '#3fb950')
      }
    }
    if (sigs.bigBid && b.delta < 0 && sigmaHigh(Math.abs(b.delta), b.dAbsMid, b.dAbsStd, k)) {
      const lv = pickMaxLevel(levels, (x) => volOf(x, unit, 'bid'))
      if (!lv || !paintAt(lv.price, volOf(lv, unit, 'bid'), 'rgba(248,81,73,0.42)', '#f85149')) {
        markTri(ctx, slot.mid - 6, yL + 10, 1, '#f85149')
      }
    }
    if (sigs.div && i > 0) {
      const p = ofBars[i - 1]
      if (b.high > p.high && b.delta < p.delta) markTri(ctx, slot.mid, yH - 16, -1, '#f0b429')
      if (b.low < p.low && b.delta > p.delta) markTri(ctx, slot.mid, yL + 16, 1, '#a371f7')
    }
    const rng = Math.max(1e-9, b.range ?? b.high - b.low)
    if (sigs.absorb && sigs.absorbMode === 'extreme') {
      const bodyHi = Math.max(b.open, b.close)
      const bodyLo = Math.min(b.open, b.close)
      const goldFill = 'rgba(240,180,41,0.40)'
      const gold = '#f0b429'
      if (b.close > b.open && b.low < bodyLo - 1e-12) {
        const wick = levels.filter((lv) => lv.price <= bodyLo + 1e-9)
        const wVol = wick.reduce((s, lv) => s + levelTot(lv, unit), 0)
        const wDlt = wick.reduce((s, lv) => s + levelDelta(lv, unit), 0)
        const volOk = wick.length
          ? sigmaHigh(wVol, b.volMid, b.volStd, k) || sigmaHigh(b.volume, b.volMid, b.volStd, k)
          : sigmaHigh(b.volume, b.volMid, b.volStd, k)
        const dltOk = wick.length ? wDlt < 0 : b.delta < 0
        if (volOk && dltOk) {
          const lv = pickMaxLevel(wick, (x) => levelTot(x, unit))
          if (!lv || !paintAt(lv.price, levelTot(lv, unit), goldFill, gold)) {
            paintAt(b.low, b.volume, goldFill, gold)
          }
        }
      }
      if (b.close < b.open && b.high > bodyHi + 1e-12) {
        const wick = levels.filter((lv) => lv.price >= bodyHi - 1e-9)
        const wVol = wick.reduce((s, lv) => s + levelTot(lv, unit), 0)
        const wDlt = wick.reduce((s, lv) => s + levelDelta(lv, unit), 0)
        const volOk = wick.length
          ? sigmaHigh(wVol, b.volMid, b.volStd, k) || sigmaHigh(b.volume, b.volMid, b.volStd, k)
          : sigmaHigh(b.volume, b.volMid, b.volStd, k)
        const dltOk = wick.length ? wDlt > 0 : b.delta > 0
        if (volOk && dltOk) {
          const lv = pickMaxLevel(wick, (x) => levelTot(x, unit))
          if (!lv || !paintAt(lv.price, levelTot(lv, unit), goldFill, gold)) {
            paintAt(b.high, b.volume, goldFill, gold)
          }
        }
      }
    } else if (sigs.absorb) {
      const bodyOk =
        Math.abs(b.close - b.open) / rng < Math.max(0.05, (sigs.absorbBodyPct || 35) / 100)
      const rangeOk = rangeInBand(rng, b.rangeUpper)
      const sizeOk = sigs.absorbMode === 'body' ? bodyOk : rangeOk
      if ((b.hh || b.ll) && sizeOk && sigmaHigh(b.volume, b.volMid, b.volStd, k)) {
        ctx.strokeStyle = '#f0b429'
        ctx.lineWidth = 1.4
        ctx.strokeRect(slot.x0, yH, slot.bw, yL - yH)
      }
    }
    if (sigs.ua && levels.length) {
      const hi = levels[levels.length - 1]
      const lo = levels[0]
      const askHi = volOf(hi, unit, 'ask')
      const bidLo = volOf(lo, unit, 'bid')
      if (askHi <= 0) markUa(ctx, slot.mid, yH, '#f0b429', 'UA H')
      if (bidLo <= 0) markUa(ctx, slot.mid, yL, '#58a6ff', 'UA L')
    }
    if (sigs.imb && levels.length) {
      drawImbalanceMarks(ctx, series, levels, slot, unit, h, sigs)
    }
  }
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  align: CanvasTextAlign,
) {
  ctx.textAlign = align
  ctx.fillStyle = COL.text
  ctx.fillText(text, cx, cy)
}

function drawAvpVa(
  ctx: CanvasRenderingContext2D,
  series: CandleSeries,
  x0: number,
  boxW: number,
  vah: number | null | undefined,
  poc: number | null | undefined,
  val: number | null | undefined,
  deltaPoc?: number | null,
  labelAt: 'left' | 'right' = 'left',
) {
  const marks: { p: number; c: string; lab: string; dy?: number }[] = []
  if (vah != null) marks.push({ p: vah, c: '#3fb950', lab: 'VAH' })
  if (poc != null) marks.push({ p: poc, c: '#f0b429', lab: 'POC' })
  if (val != null) marks.push({ p: val, c: '#58a6ff', lab: 'VAL' })
  if (deltaPoc != null && Number.isFinite(deltaPoc)) {
    const sameAsVol = poc != null && Math.abs(deltaPoc - poc) < 1e-9
    marks.push({ p: deltaPoc, c: '#ff7b72', lab: 'ΔPOC', dy: sameAsVol ? 11 : 0 })
  }
  const x1 = x0
  const x2 = x0 + boxW
  ctx.save()
  ctx.setLineDash([5, 3])
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = labelAt === 'right' ? 'left' : 'right'
  for (const m of marks) {
    const y = series.priceToCoordinate(m.p)
    if (y == null) continue
    ctx.strokeStyle = m.c
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(x1, y)
    ctx.lineTo(x2, y)
    ctx.stroke()
    ctx.fillStyle = m.c
    const lx = labelAt === 'right' ? x2 + 5 : x1 - 6
    ctx.fillText(m.lab, lx, y + (m.dy ?? 0))
  }
  ctx.restore()
}

function drawProfileInBox(
  ctx: CanvasRenderingContext2D,
  series: CandleSeries,
  levels: FootprintLevel[],
  tick: number,
  unit: Unit,
  mode: FootprintMode,
  x0: number,
  boxW: number,
  h: number,
  va?: { val?: number | null; poc?: number | null; vah?: number | null },
  opts?: { shadePane?: boolean; vaX0?: number; vaW?: number; labels?: boolean; labelAt?: 'left' | 'right' },
) {
  const agg = new Map<number, { bid: number; ask: number }>()
  for (const lv of levels) {
    const p = Number(lv.price)
    if (!Number.isFinite(p)) continue
    const cur = agg.get(p) ?? { bid: 0, ask: 0 }
    cur.bid += volOf(lv, unit, 'bid')
    cur.ask += volOf(lv, unit, 'ask')
    agg.set(p, cur)
  }
  if (!agg.size || boxW < 4) return
  let maxVol = 1e-12
  let maxAbsD = 1e-12
  let maxBid = 1e-12
  let maxAsk = 1e-12
  let volPoc = 0
  let volPocV = -1
  let deltaPoc = 0
  let deltaPocV = -1
  for (const [p, v] of agg) {
    const tot = v.bid + v.ask
    const d = Math.abs(v.ask - v.bid)
    if (tot > maxVol) maxVol = tot
    if (d > maxAbsD) maxAbsD = d
    if (v.bid > maxBid) maxBid = v.bid
    if (v.ask > maxAsk) maxAsk = v.ask
    if (tot > volPocV) {
      volPocV = tot
      volPoc = p
    }
    if (d > deltaPocV) {
      deltaPocV = d
      deltaPoc = p
    }
  }
  if (opts?.shadePane) {
    ctx.fillStyle = 'rgba(13,17,23,0.45)'
    ctx.fillRect(x0 - 4, 0, boxW + 8, h)
  }
  if (va?.vah != null && va.val != null) {
    const yH = series.priceToCoordinate(va.vah)
    const yL = series.priceToCoordinate(va.val)
    if (yH != null && yL != null) {
      const top = Math.min(yH, yL)
      const hh = Math.abs(yL - yH)
      ctx.fillStyle = 'rgba(240,180,41,0.10)'
      ctx.fillRect(x0, top, boxW, hh)
    }
  }
  for (const [p, v] of agg) {
    const yTop = series.priceToCoordinate(p + tick)
    const yBot = series.priceToCoordinate(p)
    if (yTop == null || yBot == null) continue
    const top = Math.min(yTop, yBot)
    const cellH = Math.max(1, Math.abs(yBot - yTop) - 0.4)
    if (top + cellH < 0 || top > h) continue
    const tot = v.bid + v.ask
    const delta = v.ask - v.bid
    if (mode === 'bidask') {
      const bidW = profileW(v.bid, Math.max(maxBid, maxAsk), boxW / 2 - 2)
      const askW = profileW(v.ask, Math.max(maxBid, maxAsk), boxW / 2 - 2)
      const mid = x0 + boxW / 2
      hbar(ctx, mid - bidW, top, bidW, cellH, COL.bid)
      hbar(ctx, mid, top, askW, cellH, COL.ask)
    } else if (mode === 'delta') {
      const dW = profileW(Math.abs(delta), maxAbsD, boxW)
      hbar(ctx, x0, top, dW, cellH, delta >= 0 ? COL.pos : COL.neg)
      if (Math.abs(p - deltaPoc) < tick / 2) pocStroke(ctx, x0, top, dW, cellH)
    } else if (mode === 'volume') {
      const volW = profileW(tot, maxVol, boxW)
      hbar(ctx, x0, top, volW, cellH, COL.vol)
      if (Math.abs(p - volPoc) < tick / 2) pocStroke(ctx, x0, top, volW, cellH)
    } else {
      const volW = profileW(tot, maxVol, boxW / 2 - 1)
      const dW = profileW(Math.abs(delta), maxAbsD, boxW / 2 - 1)
      const mid = x0 + boxW / 2
      hbar(ctx, mid - volW, top, volW, cellH, COL.vol)
      hbar(ctx, mid, top, dW, cellH, delta >= 0 ? COL.pos : COL.neg)
      if (Math.abs(p - volPoc) < tick / 2) pocStroke(ctx, mid - volW, top, volW, cellH)
      if (Math.abs(p - deltaPoc) < tick / 2) pocStroke(ctx, mid, top, dW, cellH)
    }
  }
  if (va && opts?.labels !== false) {
    const vx = opts?.vaX0 ?? x0
    const vw = opts?.vaW ?? boxW
    drawAvpVa(ctx, series, vx, vw, va.vah, va.poc, va.val, deltaPoc, opts?.labelAt ?? 'left')
  }
}

function drawCompositeVp(
  ctx: CanvasRenderingContext2D,
  series: CandleSeries,
  levels: FootprintLevel[],
  tick: number,
  unit: Unit,
  mode: FootprintMode,
  w: number,
  h: number,
  va?: { val?: number | null; poc?: number | null; vah?: number | null },
) {
  const boxW = 84
  const x0 = w - 4 - boxW
  drawProfileInBox(ctx, series, levels, tick, unit, mode, x0, boxW, h, va, { shadePane: true })
}

function drawSupertrend(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: CandleSeries,
  points: SupertrendPoint[],
) {
  if (!points.length) return
  ctx.save()
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  let run: SupertrendPoint[] = []
  const flush = () => {
    if (run.length < 1) {
      run = []
      return
    }
    const up = run[0].trend === 1
    ctx.strokeStyle = up ? '#3fb950' : '#f85149'
    ctx.beginPath()
    let started = false
    for (const p of run) {
      const x = chart.timeScale().timeToCoordinate(p.time as never)
      const y = series.priceToCoordinate(p.value)
      if (x == null || y == null) continue
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else {
        ctx.lineTo(x, y)
      }
    }
    if (started) ctx.stroke()
    run = []
  }
  for (const p of points) {
    if (!run.length || run[0].trend === p.trend) run.push(p)
    else {
      flush()
      run = [p]
    }
  }
  flush()
  ctx.restore()
}

function drawDevelopingVa(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: CandleSeries,
  points: AnchoredVaPoint[],
  unit: Unit,
  xEnd: number,
) {
  if (!points.length) return
  const specs: { key: 'vah' | 'poc' | 'val'; base: 'vahBase' | 'pocBase' | 'valBase'; c: string; lab: string }[] = [
    { key: 'vah', base: 'vahBase', c: '#3fb950', lab: 'VAH' },
    { key: 'poc', base: 'pocBase', c: '#f0b429', lab: 'POC' },
    { key: 'val', base: 'valBase', c: '#58a6ff', lab: 'VAL' },
  ]
  ctx.save()
  ctx.setLineDash([5, 3])
  ctx.lineWidth = 1.2
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'left'
  for (const s of specs) {
    ctx.strokeStyle = s.c
    ctx.beginPath()
    let started = false
    let lastX = 0
    let lastY = 0
    for (const p of points) {
      const raw = unit === 'quote' ? p[s.key] : (p[s.base] ?? p[s.key])
      const y = raw != null && Number.isFinite(Number(raw)) ? series.priceToCoordinate(Number(raw)) : null
      const x = chart.timeScale().timeToCoordinate(p.time as never)
      if (x == null || y == null) continue
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else {
        ctx.lineTo(x, y)
      }
      lastX = x
      lastY = y
    }
    if (!started) continue
    if (Number.isFinite(xEnd) && xEnd > lastX) ctx.lineTo(xEnd, lastY)
    ctx.stroke()
    ctx.fillStyle = s.c
    ctx.fillText(s.lab, Math.max(lastX, xEnd) + 5, lastY)
  }
  ctx.restore()
}

function drawStavpLegs(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: CandleSeries,
  rows: { leg: SupertrendLeg; profile: AnchoredProfile }[],
  tick: number,
  tfSec: number,
  unit: Unit,
  mode: FootprintMode,
  widthPct: number,
  w: number,
  h: number,
  place: StavpPlace,
) {
  const pct = Math.min(100, Math.max(1, widthPct || 50)) / 100
  for (const { leg, profile } of rows) {
    if (!profile.levels?.length) continue
    const start = barSlot(chart, leg.t0, tfSec)
    const end = barSlot(chart, leg.lastTime, tfSec)
    if (!end) continue
    const xAnchor =
      chart.timeScale().timeToCoordinate(leg.t0 as never) ?? start?.x0 ?? null
    const xEnd = end.x0 + end.bw
    if (xAnchor == null) continue
    const legW = Math.abs(xEnd - xAnchor)
    if (legW < 8) continue
    const boxW = Math.max(16, Math.min(legW, legW * pct))
    const xHist = place === 'lastCandle' ? xEnd - boxW : xAnchor
    drawProfileInBox(ctx, series, profile.levels, tick, unit, mode, xHist, boxW, h, undefined, {
      shadePane: false,
      labels: false,
    })
    const dev = profile.developing ?? []
    if (dev.length) {
      drawDevelopingVa(ctx, chart, series, dev, unit, xEnd)
    } else {
      const va =
        unit === 'quote'
          ? { val: profile.val, poc: profile.poc, vah: profile.vah }
          : { val: profile.valBase, poc: profile.pocBase, vah: profile.vahBase }
      drawAvpVa(ctx, series, xAnchor, xEnd - xAnchor, va.vah, va.poc, va.val, undefined, 'right')
    }
    const yFlip = Number.isFinite(leg.startPrice) ? series.priceToCoordinate(leg.startPrice) : null
    if (yFlip != null && xAnchor >= -8 && xAnchor <= w + 8) {
      ctx.beginPath()
      ctx.fillStyle = leg.trend === 1 ? '#3fb950' : '#f85149'
      ctx.arc(xAnchor, yFlip, 3.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(230,237,243,0.85)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
}

function draw(
  canvas: HTMLCanvasElement,
  chart: IChartApi,
  series: CandleSeries,
  bars: FootprintBar[],
  tick: number,
  avpTick: number,
  tfSec: number,
  unit: Unit,
  mode: FootprintMode,
  vazBars: FootprintBar[],
  flowBars: FootprintBar[],
  showFp: boolean,
  showVaz: boolean,
  showCot: boolean,
  showMinMax: boolean,
  showVp: boolean,
  avp: AnchoredProfile | null,
  vpMode: FootprintMode,
  vpT0?: number | null,
  vpT1?: number | null,
  showIdhl?: boolean,
  guides?: { time: number; high: number; low: number }[],
  ofBars?: OfSignalBar[],
  sigs?: OfSigFlags,
  stavpRows?: { leg: SupertrendLeg; profile: AnchoredProfile }[],
  stavpMode?: FootprintMode,
  stavpWidthPct?: number,
  stavpTick?: number,
  stavpPoints?: SupertrendPoint[],
  stavpPlace?: StavpPlace,
) {
  const pane = chart.panes()[0]
  const size = pane?.getSize()
  const host = canvas.parentElement
  const fullW = host?.clientWidth ?? canvas.clientWidth
  const gutter = priceScaleGutter(chart, fullW, host)
  let plotW: number | null = null
  try {
    const tw = (chart.timeScale() as { width?: () => number }).width?.()
    if (typeof tw === 'number' && Number.isFinite(tw) && tw > 40) plotW = Math.floor(tw)
  } catch {
    /* ignore */
  }
  const w =
    plotW != null && plotW < fullW - 40 && fullW - plotW <= 200
      ? plotW
      : Math.max(1, fullW - gutter)
  const scaleGap = Math.max(gutter, fullW - w)
  host?.style.setProperty('--price-gutter', `${scaleGap}px`)
  const chartHost =
    host instanceof HTMLElement
      ? host.classList.contains('chart-host')
        ? host
        : (host.querySelector('.chart-host') as HTMLElement | null)
      : null
  if (chartHost) clipPlotCanvases(chartHost, chart)
  const h = size?.height ?? canvas.clientHeight
  const dpr = window.devicePixelRatio || 1
  canvas.style.left = '0'
  canvas.style.right = `${scaleGap}px`
  canvas.style.width = `${w}px`
  canvas.width = Math.max(1, Math.floor(w * dpr))
  canvas.height = Math.max(1, Math.floor(h * dpr))
  canvas.style.height = `${h}px`
  canvas.style.top = `${size?.top ?? 0}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  ctx.clip()
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'middle'

  if (guides?.length) drawDaySeps(ctx, chart, guides.map((g) => g.time), h)
  if (showIdhl && guides?.length) drawIdhl(ctx, chart, series, guides, tfSec)
  if (showVaz && vazBars.length) {
    drawVaz(ctx, chart, series, vazBars, tick, tfSec, unit, h)
  }
  if (showCot || showMinMax) {
    drawFlowLabels(ctx, chart, series, flowBars, tfSec, unit, showCot, showMinMax, h)
  }
  if (showVp) {
    drawVpRangeMarks(ctx, chart, vpT0, vpT1, h)
    if (avp?.levels?.length) {
      const va =
        unit === 'quote'
          ? { val: avp.val, poc: avp.poc, vah: avp.vah }
          : { val: avp.valBase, poc: avp.pocBase, vah: avp.vahBase }
      drawCompositeVp(ctx, series, avp.levels, avpTick, unit, vpMode, w, h, va)
    }
  }
  if (stavpRows?.length) {
    drawStavpLegs(
      ctx,
      chart,
      series,
      stavpRows,
      stavpTick && stavpTick > 0 ? stavpTick : avpTick,
      tfSec,
      unit,
      stavpMode ?? 'profile',
      stavpWidthPct ?? 50,
      w,
      h,
      stavpPlace ?? 'swings',
    )
  }
  if (stavpPoints?.length) drawSupertrend(ctx, chart, series, stavpPoints)
  if (sigs && ofBars?.length) {
    drawOfSignals(ctx, chart, series, bars, ofBars, tfSec, unit, h, sigs)
  }
  if (!showFp || !bars.length) return

  const split = mode === 'profile' || mode === 'bidask'
  for (const bar of bars) {
    const slot = barSlot(chart, bar.time, tfSec)
    if (!slot) continue
    const { mid, x0, bw } = slot
    const sideGap = 1.5
    const maxSide = Math.max(4, bw / 2 - sideGap)
    const maxFull = Math.max(4, bw - 2)

    let maxVol = 1e-12
    let maxAbsD = 1e-12
    let maxBid = 1e-12
    let maxAsk = 1e-12
    let volPocPx = bar.poc ?? 0
    let deltaPocPx = bar.poc ?? 0
    for (const lv of bar.levels ?? []) {
      const bid = volOf(lv, unit, 'bid')
      const ask = volOf(lv, unit, 'ask')
      const tot = bid + ask
      const d = ask - bid
      if (tot > maxVol) {
        maxVol = tot
        volPocPx = lv.price
      }
      maxBid = Math.max(maxBid, bid)
      maxAsk = Math.max(maxAsk, ask)
      if (Math.abs(d) > maxAbsD) {
        maxAbsD = Math.abs(d)
        deltaPocPx = lv.price
      }
    }

    for (const lv of bar.levels ?? []) {
      const yTop = series.priceToCoordinate(lv.price + tick)
      const yBot = series.priceToCoordinate(lv.price)
      if (yTop == null || yBot == null) continue
      const top = Math.min(yTop, yBot)
      const cellH = Math.max(1, Math.abs(yBot - yTop) - 0.6)
      if (top + cellH < 0 || top > h) continue
      const bid = volOf(lv, unit, 'bid')
      const ask = volOf(lv, unit, 'ask')
      const tot = bid + ask
      const delta = ask - bid
      const isVolPoc = Math.abs(lv.price - volPocPx) < tick / 2
      const isDeltaPoc = Math.abs(lv.price - deltaPocPx) < tick / 2
      const cy = top + cellH / 2
      const showTxt = cellH >= 8 && bw >= 36

      if (mode === 'profile') {
        const volW = profileW(tot, maxVol, maxSide)
        const dW = profileW(Math.abs(delta), maxAbsD, maxSide)
        const volX = mid - sideGap - volW
        const dX = mid + sideGap
        hbar(ctx, volX, top, volW, cellH, COL.vol)
        hbar(ctx, dX, top, dW, cellH, delta >= 0 ? COL.pos : COL.neg)
        if (showTxt) {
          if (volW >= 14) drawLabel(ctx, fmtVol(tot), mid - sideGap - volW / 2, cy, 'center')
          else if (tot > 0) drawLabel(ctx, fmtVol(tot), mid - sideGap - 2, cy, 'right')
          if (dW >= 16) drawLabel(ctx, fmtDelta(delta), mid + sideGap + dW / 2, cy, 'center')
          else if (delta !== 0) drawLabel(ctx, fmtDelta(delta), mid + sideGap + 2, cy, 'left')
        }
        if (isVolPoc) pocStroke(ctx, volX, top, volW, cellH)
        if (isDeltaPoc) pocStroke(ctx, dX, top, dW, cellH)
      } else if (mode === 'bidask') {
        const bidW = profileW(bid, Math.max(maxBid, maxAsk), maxSide)
        const askW = profileW(ask, Math.max(maxBid, maxAsk), maxSide)
        const bidX = mid - sideGap - bidW
        const askX = mid + sideGap
        hbar(ctx, bidX, top, bidW, cellH, COL.bid)
        hbar(ctx, askX, top, askW, cellH, COL.ask)
        if (showTxt) {
          if (bidW >= 14) drawLabel(ctx, fmtVol(bid), mid - sideGap - bidW / 2, cy, 'center')
          else if (bid > 0) drawLabel(ctx, fmtVol(bid), mid - sideGap - 2, cy, 'right')
          if (askW >= 14) drawLabel(ctx, fmtVol(ask), mid + sideGap + askW / 2, cy, 'center')
          else if (ask > 0) drawLabel(ctx, fmtVol(ask), mid + sideGap + 2, cy, 'left')
        }
        if (isVolPoc) {
          pocStroke(ctx, bidX, top, bidW, cellH)
          pocStroke(ctx, askX, top, askW, cellH)
        }
      } else if (mode === 'delta') {
        const dW = profileW(Math.abs(delta), maxAbsD, maxFull)
        hbar(ctx, x0, top, dW, cellH, delta >= 0 ? COL.pos : COL.neg)
        if (showTxt && dW >= 16) drawLabel(ctx, fmtDelta(delta), x0 + dW / 2, cy, 'center')
        else if (showTxt) drawLabel(ctx, fmtDelta(delta), x0 + Math.max(dW, 4) + 2, cy, 'left')
        if (isDeltaPoc) pocStroke(ctx, x0, top, dW, cellH)
      } else {
        const volW = profileW(tot, maxVol, maxFull)
        hbar(ctx, x0, top, volW, cellH, COL.vol)
        if (showTxt && volW >= 16) drawLabel(ctx, fmtVol(tot), x0 + volW / 2, cy, 'center')
        else if (showTxt) drawLabel(ctx, fmtVol(tot), x0 + Math.max(volW, 4) + 2, cy, 'left')
        if (isVolPoc) pocStroke(ctx, x0, top, volW, cellH)
      }
    }

    if (split) drawSpine(ctx, series, bar, mid)
  }
}

export function FootprintOverlay({
  chartRef,
  seriesRef,
  wrapRef,
  chartEpoch,
  show,
  showVaz,
  showCot,
  showMinMax,
  showVp = false,
  vpMode = 'profile',
  vpBinMult,
  vazBinMult,
  vpT0 = null,
  vpT1 = null,
  showStavp = false,
  stavpMode = 'profile',
  stavpBinMult,
  stavpWidthPct = 50,
  stavpPlace = 'swings',
  stavpLegs = [],
  stavpPoints = [],
  onStavpProfiles,
  showIdhl = false,
  guides = [],
  ofBars = [],
  showImb = false,
  showDiv = false,
  showAbsorb = false,
  absorbMode = 'range',
  absorbBodyPct = 35,
  showUa = false,
  showBigVol = false,
  showBigAsk = false,
  showBigBid = false,
  imbRatio = 3,
  imbConsec = 1,
  imbIgnoreZero = true,
  imbMode = 'diagonal',
  bigMult = 2,
  symbol,
  tf,
  unit,
  mode,
  binMult,
  barTimes,
  onVazBars,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hint, setHint] = useState<string | null>(null)
  const barsRef = useRef<FootprintBar[]>([])
  const vazRef = useRef<FootprintBar[]>([])
  const flowRef = useRef<FootprintBar[]>([])
  const onVazBarsRef = useRef(onVazBars)
  onVazBarsRef.current = onVazBars
  const onStavpProfilesRef = useRef(onStavpProfiles)
  onStavpProfilesRef.current = onStavpProfiles
  const avpRef = useRef<AnchoredProfile | null>(null)
  const stavpRowsRef = useRef<{ leg: SupertrendLeg; profile: AnchoredProfile }[]>([])
  const stavpTickRef = useRef(0.01)
  const stavpKeyRef = useRef('')
  const fpTickRef = useRef(0.01)
  const avpTickRef = useRef(0.01)
  const fpKeyRef = useRef('')
  const avpKeyRef = useRef('')
  const vazKeyRef = useRef('')
  const modeRef = useRef(mode)
  const vpModeRef = useRef(vpMode)
  const unitRef = useRef(unit)
  const showRef = useRef(show)
  const showVazRef = useRef(showVaz)
  const showCotRef = useRef(showCot)
  const showMinMaxRef = useRef(showMinMax)
  const showVpRef = useRef(showVp)
  const showStavpRef = useRef(showStavp)
  const stavpModeRef = useRef(stavpMode)
  const stavpWidthRef = useRef(stavpWidthPct)
  const stavpPlaceRef = useRef(stavpPlace)
  const stavpLegsRef = useRef(stavpLegs)
  const stavpPointsRef = useRef(stavpPoints)
  const showIdhlRef = useRef(showIdhl)
  const guidesRef = useRef(guides)
  const vpT0Ref = useRef(vpT0)
  const vpT1Ref = useRef(vpT1)
  modeRef.current = mode
  vpModeRef.current = vpMode
  unitRef.current = unit
  showRef.current = show
  showVazRef.current = showVaz
  showCotRef.current = showCot
  showMinMaxRef.current = showMinMax
  showVpRef.current = showVp
  showStavpRef.current = showStavp
  stavpModeRef.current = stavpMode
  stavpWidthRef.current = stavpWidthPct
  stavpPlaceRef.current = stavpPlace
  stavpLegsRef.current = stavpLegs
  stavpPointsRef.current = stavpPoints
  showIdhlRef.current = showIdhl
  guidesRef.current = guides
  vpT0Ref.current = vpT0
  vpT1Ref.current = vpT1
  const binSafe = Math.max(1, Math.round(Number(binMult) || 1))
  const vpBinSafe = Math.max(1, Math.round(Number(vpBinMult ?? binMult) || 1))
  const vazBinSafe = Math.max(1, Math.round(Number(vazBinMult ?? binMult) || 1))
  const stavpBinSafe = Math.max(1, Math.round(Number(stavpBinMult ?? binMult) || 1))
  const stavpLegKey = stavpLegs.map((l) => `${l.t0}-${l.t1}`).join('|')
  const wantFpData =
    show ||
    showImb ||
    showUa ||
    showBigVol ||
    showBigAsk ||
    showBigBid ||
    (showAbsorb && absorbMode === 'extreme')
  const sigs: OfSigFlags = {
    imb: showImb,
    div: showDiv,
    absorb: showAbsorb,
    absorbMode,
    absorbBodyPct,
    ua: showUa,
    bigVol: showBigVol,
    bigAsk: showBigAsk,
    bigBid: showBigBid,
    imbRatio,
    imbConsec,
    imbIgnoreZero,
    imbMode,
    bigMult,
  }
  const sigsRef = useRef(sigs)
  sigsRef.current = sigs
  const ofBarsRef = useRef(ofBars)
  ofBarsRef.current = ofBars
  const active = Boolean(barTimes.length)

  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    const canvas = canvasRef.current
    if (!active || !chart || !series || !canvas) {
      setHint(null)
      barsRef.current = []
      vazRef.current = []
      flowRef.current = []
      avpRef.current = null
      stavpRowsRef.current = []
      fpKeyRef.current = ''
      avpKeyRef.current = ''
      vazKeyRef.current = ''
      stavpKeyRef.current = ''
      onStavpProfilesRef.current?.([])
      onVazBarsRef.current?.([])
      const c = canvasRef.current?.getContext('2d')
      if (c && canvasRef.current) {
        c.setTransform(1, 0, 0, 1, 0, 0)
        c.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      }
      return
    }

    let timer: number | null = null
    let aborted = false
    const fpAc = { current: new AbortController() }
    const vazAc = { current: new AbortController() }
    const vpAc = { current: new AbortController() }
    const stavpAc = { current: new AbortController() }
    const flowAc = { current: new AbortController() }
    let flowKey = ''

    const paint = () => {
      if (!canvasRef.current || !chartRef.current || !seriesRef.current) return
      onVazBarsRef.current?.(showVazRef.current ? vazRef.current : [])
      draw(
        canvasRef.current,
        chartRef.current,
        seriesRef.current,
        barsRef.current,
        fpTickRef.current,
        avpTickRef.current,
        Math.max(1, tf) * 60,
        unitRef.current,
        modeRef.current,
        vazRef.current,
        flowRef.current,
        showRef.current,
        showVazRef.current,
        showCotRef.current,
        showMinMaxRef.current,
        showVpRef.current,
        avpRef.current,
        vpModeRef.current,
        vpT0Ref.current,
        vpT1Ref.current,
        showIdhlRef.current,
        guidesRef.current,
        ofBarsRef.current,
        sigsRef.current,
        showStavpRef.current ? stavpRowsRef.current : [],
        stavpModeRef.current,
        stavpWidthRef.current,
        stavpTickRef.current,
        showStavpRef.current ? stavpPointsRef.current : [],
        stavpPlaceRef.current,
      )
    }

    const visibleWindow = () => {
      const ts = chart.timeScale()
      const log = ts.getVisibleLogicalRange()
      const host = wrapRef.current
      if (!log || !host || !barTimes.length) return null
      const fromIdx = Math.max(0, Math.floor(log.from))
      const toIdx = Math.min(barTimes.length - 1, Math.ceil(log.to))
      const t0 = barTimes[fromIdx]
      const t1 = barTimes[toIdx] + tf * 60
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null
      const nBars = log.to - log.from
      const barPx = Math.max(1, (host.clientWidth - 56) / Math.max(1, nBars))
      return { t0, t1, nBars, barPx }
    }

    const applyFpCandles = (on: boolean) => {
      if (!on) return
      series.applyOptions({
        upColor: 'rgba(63,185,80,0.50)',
        downColor: 'rgba(248,81,73,0.50)',
        wickUpColor: 'rgba(63,185,80,0.85)',
        wickDownColor: 'rgba(248,81,73,0.85)',
        borderVisible: true,
        borderUpColor: 'rgba(63,185,80,0.80)',
        borderDownColor: 'rgba(248,81,73,0.80)',
      })
    }

    const avpWindow = (win: { t0: number; t1: number }) => {
      const a = vpT0Ref.current
      const b = vpT1Ref.current
      let t0 = a != null && Number.isFinite(a) ? a : win.t0
      let t1 = b != null && Number.isFinite(b) ? b + tf * 60 : win.t1
      if (t1 <= t0) t1 = t0 + tf * 60
      return { t0, t1 }
    }

    const load = () => {
      const win = visibleWindow()
      if (!win) return
      const hints: string[] = []
      const fpZoomed =
        win.barPx >= FOOTPRINT_MIN_BAR_PX && win.nBars <= FOOTPRINT_MAX_BARS
      const reuseVazFromFp = wantFpData && showVazRef.current && fpZoomed && vazBinSafe === binSafe

      if (wantFpData) {
        if (!fpZoomed) {
          fpAc.current.abort()
          fpAc.current = new AbortController()
          barsRef.current = []
          fpKeyRef.current = `zoom:${Math.round(win.nBars)}`
          hints.push('Zoom in for footprint')
          applyFpCandles(false)
        } else {
          const fpKey = `${symbol}:${tf}:${binSafe}:${win.t0}:${win.t1}`
          if (fpKey !== fpKeyRef.current || !barsRef.current.length) {
            fpKeyRef.current = fpKey
            hints.push('Loading footprint…')
            fpAc.current.abort()
            fpAc.current = new AbortController()
            void fetchFootprint(
              { symbol, tf, t0: win.t0, t1: win.t1, bin_mult: binSafe },
              fpAc.current.signal,
            )
              .then((r) => {
                if (aborted) return
                if (!r.ok || r.reason === 'zoom_in') {
                  barsRef.current = []
                  applyFpCandles(false)
                  setHint(showVazRef.current && vazRef.current.length ? null : 'Zoom in for footprint')
                  paint()
                  return
                }
                barsRef.current = r.bars || []
                if (showVazRef.current) vazRef.current = barsRef.current
                fpTickRef.current = Number(r.tick_size || fpTickRef.current || 0.01)
                applyFpCandles(showRef.current)
                setHint(barsRef.current.length ? null : 'No ticks in view')
                paint()
              })
              .catch((e) => {
                if (aborted || (e instanceof DOMException && e.name === 'AbortError')) return
                barsRef.current = []
                setHint(String(e.message || e))
                paint()
              })
          }
        }
      } else {
        fpAc.current.abort()
        barsRef.current = []
        fpKeyRef.current = ''
        applyFpCandles(false)
      }

      if (showVpRef.current) {
        const { t0, t1 } = avpWindow(win)
        const avpKey = `${symbol}:${tf}:${vpBinSafe}:${t0}:${t1}`
        if (avpKey !== avpKeyRef.current || !avpRef.current) {
          avpKeyRef.current = avpKey
          vpAc.current.abort()
          vpAc.current = new AbortController()
          if (!showRef.current) hints.push('Loading AVP…')
          void fetchAnchoredProfile(
            { symbol, tf, t0, t1, bin_mult: vpBinSafe },
            vpAc.current.signal,
          )
            .then((r) => {
              if (aborted) return
              if (!r.ok) {
                avpRef.current = null
                if (!showRef.current) setHint('AVP range failed')
                paint()
                return
              }
              avpRef.current = r
              avpTickRef.current = Number(r.tick_size || avpTickRef.current || 0.01)
              if (!showRef.current) setHint(r.levels?.length ? null : 'No ticks in AVP range')
              paint()
            })
            .catch((e) => {
              if (aborted || (e instanceof DOMException && e.name === 'AbortError')) return
              avpRef.current = null
              if (!showRef.current) setHint(String(e.message || e))
              paint()
            })
        }
      } else {
        vpAc.current.abort()
        avpRef.current = null
        avpKeyRef.current = ''
      }

      if (showStavpRef.current && stavpLegsRef.current.length) {
        const vis = stavpLegsRef.current.filter((l) => l.t1 > win.t0 && l.t0 < win.t1)
        const take = vis.length > STAVP_MAX_LEGS ? vis.slice(-STAVP_MAX_LEGS) : vis
        const stavpKey = `${symbol}:${tf}:${stavpBinSafe}:${take.map((l) => `${l.t0}-${l.t1}`).join('|')}`
        const already = stavpKey === stavpKeyRef.current && stavpRowsRef.current.length > 0
        if (!take.length) {
          if (stavpKeyRef.current || stavpRowsRef.current.length) {
            stavpRowsRef.current = []
            stavpKeyRef.current = ''
            onStavpProfilesRef.current?.([])
          }
        } else if (!already && stavpKey !== stavpKeyRef.current) {
          const pendingKey = stavpKey
          stavpAc.current.abort()
          stavpAc.current = new AbortController()
          if (!showRef.current && !showVpRef.current && !stavpRowsRef.current.length) {
            hints.push('Loading STAVP…')
          }
          const signal = stavpAc.current.signal
          void fetchAnchoredProfiles(
            {
              symbol,
              tf,
              bin_mult: stavpBinSafe,
              ranges: take.map((l) => ({ t0: l.t0, t1: l.t1 })),
            },
            signal,
          )
            .then((r) => {
              if (aborted) return
              stavpRowsRef.current = take
                .map((leg, i) => ({
                  leg,
                  profile: (r.profiles || [])[i],
                }))
                .filter((row): row is { leg: SupertrendLeg; profile: AnchoredProfile } =>
                  Boolean(row.profile?.ok && row.profile.levels?.length),
                )
              stavpKeyRef.current = pendingKey
              const tick = r.tick_size ?? stavpRowsRef.current[0]?.profile.tick_size
              if (tick) stavpTickRef.current = Number(tick)
              onStavpProfilesRef.current?.(
                stavpRowsRef.current.map((row) => ({
                  t0: row.leg.t0,
                  t1: row.leg.t1,
                  lastTime: row.leg.lastTime,
                  trend: row.leg.trend,
                  vah: row.profile.vah,
                  poc: row.profile.poc,
                  val: row.profile.val,
                  vahBase: row.profile.vahBase,
                  pocBase: row.profile.pocBase,
                  valBase: row.profile.valBase,
                  developing: row.profile.developing ?? [],
                })),
              )
              if (!showRef.current && !showVpRef.current) {
                setHint(stavpRowsRef.current.length ? null : 'No aggTrades in these SuperTrend legs')
              }
              paint()
            })
            .catch((e) => {
              if (aborted || (e instanceof DOMException && e.name === 'AbortError')) return
              stavpRowsRef.current = []
              stavpKeyRef.current = ''
              onStavpProfilesRef.current?.([])
              if (!showRef.current && !showVpRef.current) setHint(String(e.message || e))
              paint()
            })
        }
      } else {
        stavpAc.current.abort()
        if (stavpKeyRef.current || stavpRowsRef.current.length) {
          stavpRowsRef.current = []
          stavpKeyRef.current = ''
          onStavpProfilesRef.current?.([])
        }
      }

      if (showVazRef.current) {
        if (win.nBars > VAZ_MAX_BARS) {
          vazAc.current.abort()
          vazAc.current = new AbortController()
          vazRef.current = []
          vazKeyRef.current = `zoom:${Math.round(win.nBars)}`
          if (!showRef.current) hints.push('Zoom in for VAZ')
        } else if (reuseVazFromFp) {
          vazAc.current.abort()
          vazKeyRef.current = `${symbol}:${tf}:${vazBinSafe}:${win.t0}:${win.t1}:fp`
          if (barsRef.current.length) vazRef.current = barsRef.current
        } else {
          const vazKey = `${symbol}:${tf}:${vazBinSafe}:${win.t0}:${win.t1}`
          if (vazKey !== vazKeyRef.current || !vazRef.current.length) {
            vazKeyRef.current = vazKey
            vazAc.current.abort()
            vazAc.current = new AbortController()
            void fetchValueArea(
              { symbol, tf, t0: win.t0, t1: win.t1, bin_mult: vazBinSafe },
              vazAc.current.signal,
            )
              .then((r) => {
                if (aborted) return
                if (!r.ok || r.reason === 'zoom_in') {
                  vazRef.current = []
                  if (!showRef.current) setHint('Zoom in for VAZ')
                  paint()
                  return
                }
                vazRef.current = r.bars || []
                fpTickRef.current = Number(r.tick_size || fpTickRef.current || 0.01)
                if (!showRef.current) setHint(vazRef.current.length ? null : 'No ticks in view')
                paint()
              })
              .catch((e) => {
                if (aborted || (e instanceof DOMException && e.name === 'AbortError')) return
                vazRef.current = []
                if (!showRef.current) setHint(String(e.message || e))
                paint()
              })
          }
        }
      } else {
        vazAc.current.abort()
        vazRef.current = []
        vazKeyRef.current = ''
      }

      const want = showCotRef.current || showMinMaxRef.current
      if (want) {
        if (win.nBars > FLOW_MAX_BARS) {
          if (flowKey !== `zoom:${Math.round(win.nBars)}`) {
            flowKey = `zoom:${Math.round(win.nBars)}`
            flowAc.current.abort()
            flowAc.current = new AbortController()
          }
          if (!showRef.current && !showVazRef.current) hints.push('Zoom in for COT / MinΔ')
        } else {
          const key = `${win.t0}:${win.t1}`
          if (key !== flowKey) {
            flowKey = key
            flowAc.current.abort()
            flowAc.current = new AbortController()
            if (!flowRef.current.length) hints.push('Loading COT / MinΔ…')
            void fetchFlowStats({ symbol, tf, t0: win.t0, t1: win.t1 }, flowAc.current.signal)
              .then((r) => {
                if (aborted) return
                if (!r.ok || r.reason === 'zoom_in') {
                  flowRef.current = []
                  if (!showRef.current && !showVazRef.current) setHint('Zoom in for COT / MinΔ')
                  paint()
                  return
                }
                flowRef.current = r.bars || []
                if (!showRef.current && !showVazRef.current) {
                  setHint(flowRef.current.length ? null : 'No ticks in view')
                }
                paint()
              })
              .catch((e) => {
                if (aborted || (e instanceof DOMException && e.name === 'AbortError')) return
                if (!flowRef.current.length && !showRef.current && !showVazRef.current) {
                  setHint(String(e.message || e))
                }
                paint()
              })
          }
        }
      } else {
        flowAc.current.abort()
        flowRef.current = []
        flowKey = ''
      }

      if (hints.length) setHint(hints[0] ?? null)
      paint()
    }

    const schedule = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(load, 350)
      paint()
    }

    schedule()
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule)
    window.addEventListener('resize', schedule)
    const wrap = wrapRef.current
    const ro = wrap ? new ResizeObserver(() => paint()) : null
    if (wrap && ro) ro.observe(wrap)
    return () => {
      aborted = true
      fpAc.current.abort()
      vazAc.current.abort()
      vpAc.current.abort()
      stavpAc.current.abort()
      flowAc.current.abort()
      if (timer != null) window.clearTimeout(timer)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule)
      window.removeEventListener('resize', schedule)
      ro?.disconnect()
    }
  }, [active, show, showVaz, showCot, showMinMax, showVp, showStavp, showImb, showUa, wantFpData, symbol, tf, binSafe, vpBinSafe, vazBinSafe, stavpBinSafe, stavpLegKey, vpT0, vpT1, chartEpoch, chartRef, seriesRef, wrapRef, barTimes])

  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    const chart = chartRef.current
    const series = seriesRef.current
    if (!canvas || !chart || !series) return
    draw(
      canvas,
      chart,
      series,
      barsRef.current,
      fpTickRef.current,
      avpTickRef.current,
      Math.max(1, tf) * 60,
      unit,
      mode,
      vazRef.current,
      flowRef.current,
      show,
      showVaz,
      showCot,
      showMinMax,
      showVp,
      avpRef.current,
      vpMode,
      vpT0,
      vpT1,
      showIdhl,
      guides,
      ofBars,
      sigsRef.current,
      showStavp ? stavpRowsRef.current : [],
      stavpMode,
      stavpWidthPct,
      stavpTickRef.current,
      showStavp ? stavpPoints : [],
      stavpPlace,
    )
  }, [
    active,
    show,
    showVaz,
    showCot,
    showMinMax,
    showVp,
    showStavp,
    stavpMode,
    stavpWidthPct,
    stavpPlace,
    stavpPoints,
    vpMode,
    vpT0,
    vpT1,
    showIdhl,
    guides,
    ofBars,
    showImb,
    showDiv,
    showAbsorb,
    absorbMode,
    absorbBodyPct,
    showUa,
    showBigVol,
    showBigAsk,
    showBigBid,
    imbRatio,
    imbConsec,
    imbIgnoreZero,
    imbMode,
    bigMult,
    mode,
    unit,
    tf,
  ])

  if (!active) return null

  return (
    <>
      <canvas className="footprint-canvas" ref={canvasRef} />
      {hint && <div className="footprint-hint">{hint}</div>}
    </>
  )
}
