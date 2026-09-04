import { useEffect, useRef, useState, type RefObject } from 'react'
import type { IChartApi } from '@stocksharp/chart'
import { fetchFlowStats, fetchFootprint, fetchValueArea, type FootprintBar, type FootprintLevel } from './api'

export type CandleSeries = {
  priceToCoordinate: (price: number) => number | null
  applyOptions: (opts: Record<string, unknown>) => void
}

export type FootprintMode = 'profile' | 'bidask' | 'delta' | 'volume'

/** Need wide bars so profile cells are readable. */
export const FOOTPRINT_MIN_BAR_PX = 24
export const FOOTPRINT_MAX_BARS = 64
export const VAZ_MAX_BARS = 512
export const FLOW_MAX_BARS = 512

type Unit = 'quote' | 'base'

type Props = {
  chartRef: RefObject<IChartApi | null>
  seriesRef: RefObject<CandleSeries | null>
  wrapRef: RefObject<HTMLDivElement | null>
  chartEpoch: number
  show: boolean
  showVaz: boolean
  showCot: boolean
  showMinMax: boolean
  symbol: string
  tf: number
  unit: Unit
  mode: FootprintMode
  binMult: number
  barTimes: number[]
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
    ctx.strokeStyle = kind === 'ch' ? COL.posTxt : kind === 'cl' ? COL.negTxt : ink
    ctx.lineWidth = 1.5
    ctx.setLineDash([3, 2])
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1)
    ctx.setLineDash([])
  }
  ctx.fillStyle = ink
  ctx.textAlign = 'center'
  ctx.fillText(text, x, y)
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
  const ts = chart.timeScale()
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  for (const bar of bars) {
    const f = flowOf(bar, unit)
    const x0 = ts.timeToCoordinate(bar.time as never)
    const x1 = ts.timeToCoordinate((bar.time + tfSec) as never)
    if (x0 == null) continue
    const right = x1 != null && x1 > x0 ? x1 : x0 + 8
    const bw = Math.max(4, right - x0 - 1)
    if (bw < 6) continue
    const compact = bw < 28
    const mid = x0 + bw / 2
    const yH = series.priceToCoordinate(bar.high)
    const yL = series.priceToCoordinate(bar.low)
    if (yH == null || yL == null) continue
    ctx.font = compact
      ? '9px ui-sans-serif, system-ui, sans-serif'
      : '10px ui-sans-serif, system-ui, sans-serif'
    let above = yH - 7
    let below = yL + 7
    if (showCot && f.ch != null && Number.isFinite(f.ch)) {
      const txt = compact ? fmtDelta(f.ch) : `CH ${fmtDelta(f.ch)}`
      if (above > 4 && above < h - 4) drawSignedPill(ctx, txt, mid, above, f.ch, 'ch')
      above -= compact ? 11 : 13
    }
    if (showMinMax && f.maxD != null && Number.isFinite(f.maxD)) {
      const txt = compact ? fmtDelta(f.maxD) : `Max ${fmtDelta(f.maxD)}`
      if (above > 4 && above < h - 4) drawSignedPill(ctx, txt, mid, above, f.maxD, 'max')
      above -= compact ? 11 : 13
    }
    if (showCot && f.cl != null && Number.isFinite(f.cl)) {
      const txt = compact ? fmtDelta(f.cl) : `CL ${fmtDelta(f.cl)}`
      if (below > 4 && below < h - 4) drawSignedPill(ctx, txt, mid, below, f.cl, 'cl')
      below += compact ? 11 : 13
    }
    if (showMinMax && f.minD != null && Number.isFinite(f.minD)) {
      const txt = compact ? fmtDelta(f.minD) : `Min ${fmtDelta(f.minD)}`
      if (below > 4 && below < h - 4) drawSignedPill(ctx, txt, mid, below, f.minD, 'min')
      below += compact ? 11 : 13
    }
  }
}

function vazOf(bar: FootprintBar, unit: Unit): { val: number; vah: number } | null {
  const val = unit === 'quote' ? bar.val : (bar.valBase ?? bar.val)
  const vah = unit === 'quote' ? bar.vah : (bar.vahBase ?? bar.vah)
  if (val == null || vah == null || !Number.isFinite(val) || !Number.isFinite(vah)) return null
  return { val, vah: Math.max(val, vah) }
}

function drawVaz(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: CandleSeries,
  bars: FootprintBar[],
  tick: number,
  tfSec: number,
  unit: Unit,
  h: number,
) {
  const ts = chart.timeScale()
  for (const bar of bars) {
    const za = vazOf(bar, unit)
    if (!za) continue
    const x0 = ts.timeToCoordinate(bar.time as never)
    const x1 = ts.timeToCoordinate((bar.time + tfSec) as never)
    if (x0 == null) continue
    const right = x1 != null && x1 > x0 ? x1 : x0 + 8
    const bw = Math.max(3, right - x0 - 1)
    const yTop = series.priceToCoordinate(za.vah + tick)
    const yBot = series.priceToCoordinate(za.val)
    if (yTop == null || yBot == null) continue
    const top = Math.min(yTop, yBot)
    const zh = Math.max(1, Math.abs(yBot - yTop))
    if (top + zh < 0 || top > h) continue
    ctx.fillStyle = COL.vaz
    ctx.fillRect(x0, top, bw, zh)
    ctx.strokeStyle = COL.vazLine
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x0, top + 0.5)
    ctx.lineTo(x0 + bw, top + 0.5)
    ctx.moveTo(x0, top + zh - 0.5)
    ctx.lineTo(x0 + bw, top + zh - 0.5)
    ctx.stroke()
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

function draw(
  canvas: HTMLCanvasElement,
  chart: IChartApi,
  series: CandleSeries,
  bars: FootprintBar[],
  tick: number,
  tfSec: number,
  unit: Unit,
  mode: FootprintMode,
  vazBars: FootprintBar[],
  flowBars: FootprintBar[],
  showFp: boolean,
  showVaz: boolean,
  showCot: boolean,
  showMinMax: boolean,
) {
  const pane = chart.panes()[0]
  const size = pane?.getSize()
  const w = canvas.clientWidth
  const h = size?.height ?? canvas.clientHeight
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.floor(w * dpr))
  canvas.height = Math.max(1, Math.floor(h * dpr))
  canvas.style.height = `${h}px`
  canvas.style.top = `${size?.top ?? 0}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'middle'

  if (showVaz && vazBars.length) {
    drawVaz(ctx, chart, series, vazBars, tick, tfSec, unit, h)
  }
  if (showCot || showMinMax) {
    drawFlowLabels(ctx, chart, series, flowBars, tfSec, unit, showCot, showMinMax, h)
  }
  if (!showFp || !bars.length) return

  const ts = chart.timeScale()
  const split = mode === 'profile' || mode === 'bidask'
  for (const bar of bars) {
    const x0 = ts.timeToCoordinate(bar.time as never)
    const x1 = ts.timeToCoordinate((bar.time + tfSec) as never)
    if (x0 == null) continue
    const right = x1 != null && x1 > x0 ? x1 : x0 + 8
    const bw = Math.max(4, right - x0 - 1)
    const mid = x0 + bw / 2
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
  symbol,
  tf,
  unit,
  mode,
  binMult,
  barTimes,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hint, setHint] = useState<string | null>(null)
  const barsRef = useRef<FootprintBar[]>([])
  const vazRef = useRef<FootprintBar[]>([])
  const flowRef = useRef<FootprintBar[]>([])
  const tickRef = useRef(0.01)
  const modeRef = useRef(mode)
  const unitRef = useRef(unit)
  const showRef = useRef(show)
  const showVazRef = useRef(showVaz)
  const showCotRef = useRef(showCot)
  const showMinMaxRef = useRef(showMinMax)
  modeRef.current = mode
  unitRef.current = unit
  showRef.current = show
  showVazRef.current = showVaz
  showCotRef.current = showCot
  showMinMaxRef.current = showMinMax
  const binSafe = Math.max(1, Math.round(Number(binMult) || 1))
  const wantFlow = showCot || showMinMax
  const active = show || showVaz || wantFlow

  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    const canvas = canvasRef.current
    if (!active || !chart || !series || !canvas) {
      setHint(null)
      barsRef.current = []
      vazRef.current = []
      flowRef.current = []
      const c = canvasRef.current?.getContext('2d')
      if (c && canvasRef.current) {
        c.setTransform(1, 0, 0, 1, 0, 0)
        c.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      }
      seriesRef.current?.applyOptions({
        upColor: '#3fb950',
        downColor: '#f85149',
        wickUpColor: '#3fb950',
        wickDownColor: '#f85149',
        borderVisible: false,
      })
      return
    }

    let timer: number | null = null
    let aborted = false
    const fpAc = { current: new AbortController() }
    const vazAc = { current: new AbortController() }
    const flowAc = { current: new AbortController() }
    let flowKey = ''

    const paint = () => {
      if (!canvasRef.current || !chartRef.current || !seriesRef.current) return
      draw(
        canvasRef.current,
        chartRef.current,
        seriesRef.current,
        barsRef.current,
        tickRef.current,
        Math.max(1, tf) * 60,
        unitRef.current,
        modeRef.current,
        vazRef.current,
        flowRef.current,
        showRef.current,
        showVazRef.current,
        showCotRef.current,
        showMinMaxRef.current,
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
      if (on) {
        series.applyOptions({
          upColor: 'rgba(63,185,80,0.50)',
          downColor: 'rgba(248,81,73,0.50)',
          wickUpColor: 'rgba(63,185,80,0.85)',
          wickDownColor: 'rgba(248,81,73,0.85)',
          borderVisible: true,
          borderUpColor: 'rgba(63,185,80,0.80)',
          borderDownColor: 'rgba(248,81,73,0.80)',
        })
      } else {
        series.applyOptions({
          upColor: '#3fb950',
          downColor: '#f85149',
          wickUpColor: '#3fb950',
          wickDownColor: '#f85149',
          borderVisible: false,
        })
      }
    }

    const load = () => {
      const win = visibleWindow()
      if (!win) return
      const hints: string[] = []

      if (showRef.current) {
        if (win.barPx < FOOTPRINT_MIN_BAR_PX || win.nBars > FOOTPRINT_MAX_BARS) {
          fpAc.current.abort()
          fpAc.current = new AbortController()
          barsRef.current = []
          hints.push('Zoom in for footprint')
          applyFpCandles(false)
        } else {
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
              tickRef.current = Number(r.tick_size || tickRef.current || 0.01)
              applyFpCandles(true)
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
      } else {
        fpAc.current.abort()
        barsRef.current = []
        applyFpCandles(false)
      }

      if (showVazRef.current) {
        if (win.nBars > VAZ_MAX_BARS) {
          vazAc.current.abort()
          vazAc.current = new AbortController()
          vazRef.current = []
          if (!showRef.current) hints.push('Zoom in for VAZ')
        } else {
          vazAc.current.abort()
          vazAc.current = new AbortController()
          void fetchValueArea(
            { symbol, tf, t0: win.t0, t1: win.t1, bin_mult: binSafe },
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
              tickRef.current = Number(r.tick_size || tickRef.current || 0.01)
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
      } else {
        vazAc.current.abort()
        vazRef.current = []
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
    return () => {
      aborted = true
      fpAc.current.abort()
      vazAc.current.abort()
      flowAc.current.abort()
      if (timer != null) window.clearTimeout(timer)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [active, show, showVaz, showCot, showMinMax, symbol, tf, binSafe, chartEpoch, chartRef, seriesRef, wrapRef, barTimes])

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
      tickRef.current,
      Math.max(1, tf) * 60,
      unit,
      mode,
      vazRef.current,
      flowRef.current,
      show,
      showVaz,
      showCot,
      showMinMax,
    )
  }, [active, show, showVaz, showCot, showMinMax, mode, unit, tf])

  if (!active) return null

  return (
    <>
      <canvas className="footprint-canvas" ref={canvasRef} />
      {hint && <div className="footprint-hint">{hint}</div>}
    </>
  )
}
