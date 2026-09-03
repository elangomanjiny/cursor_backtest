import { useEffect, useRef, useState, type RefObject } from 'react'
import type { IChartApi } from '@stocksharp/chart'
import { fetchFootprint, type FootprintBar } from './api'

export type CandleSeries = {
  priceToCoordinate: (price: number) => number | null
  applyOptions: (opts: Record<string, unknown>) => void
}

export type FootprintMode = 'profile' | 'bidask' | 'delta' | 'volume'

/** Need wide bars so profile cells are readable. */
export const FOOTPRINT_MIN_BAR_PX = 24
export const FOOTPRINT_MAX_BARS = 64

type Unit = 'quote' | 'base'

type Props = {
  chartRef: RefObject<IChartApi | null>
  seriesRef: RefObject<CandleSeries | null>
  wrapRef: RefObject<HTMLDivElement | null>
  chartEpoch: number
  show: boolean
  symbol: string
  tf: number
  unit: Unit
  mode: FootprintMode
  binMult: number
  barTimes: number[]
}

function volOf(bar: FootprintBar['levels'][number], unit: Unit, side: 'bid' | 'ask') {
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
  poc: 'rgba(184,148,48,0.88)',
  pos: 'rgba(63,185,80,0.48)',
  neg: 'rgba(248,81,73,0.48)',
  bid: 'rgba(248,81,73,0.48)',
  ask: 'rgba(63,185,80,0.48)',
  text: 'rgba(240,246,252,0.95)',
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
    let maxDPrice = bar.poc ?? 0
    for (const lv of bar.levels) {
      const bid = volOf(lv, unit, 'bid')
      const ask = volOf(lv, unit, 'ask')
      const tot = bid + ask
      const d = ask - bid
      maxVol = Math.max(maxVol, tot)
      maxBid = Math.max(maxBid, bid)
      maxAsk = Math.max(maxAsk, ask)
      if (Math.abs(d) >= maxAbsD) {
        maxAbsD = Math.abs(d)
        maxDPrice = lv.price
      }
    }

    for (const lv of bar.levels) {
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
      const isPoc = bar.poc != null && Math.abs(lv.price - bar.poc) < tick / 2
      const isMaxD = Math.abs(lv.price - maxDPrice) < tick / 2
      const cy = top + cellH / 2
      const showTxt = cellH >= 8 && bw >= 36

      if (mode === 'profile') {
        const volW = profileW(tot, maxVol, maxSide)
        const dW = profileW(Math.abs(delta), maxAbsD, maxSide)
        hbar(ctx, mid - sideGap - volW, top, volW, cellH, isPoc ? COL.poc : COL.vol)
        hbar(ctx, mid + sideGap, top, dW, cellH, isMaxD ? COL.poc : delta >= 0 ? COL.pos : COL.neg)
        if (showTxt) {
          if (volW >= 14) drawLabel(ctx, fmtVol(tot), mid - sideGap - volW / 2, cy, 'center')
          else if (tot > 0) drawLabel(ctx, fmtVol(tot), mid - sideGap - 2, cy, 'right')
          if (dW >= 16) drawLabel(ctx, fmtDelta(delta), mid + sideGap + dW / 2, cy, 'center')
          else if (delta !== 0) drawLabel(ctx, fmtDelta(delta), mid + sideGap + 2, cy, 'left')
        }
      } else if (mode === 'bidask') {
        const bidW = profileW(bid, Math.max(maxBid, maxAsk), maxSide)
        const askW = profileW(ask, Math.max(maxBid, maxAsk), maxSide)
        hbar(ctx, mid - sideGap - bidW, top, bidW, cellH, isPoc ? COL.poc : COL.bid)
        hbar(ctx, mid + sideGap, top, askW, cellH, isPoc ? COL.poc : COL.ask)
        if (showTxt) {
          if (bidW >= 14) drawLabel(ctx, fmtVol(bid), mid - sideGap - bidW / 2, cy, 'center')
          else if (bid > 0) drawLabel(ctx, fmtVol(bid), mid - sideGap - 2, cy, 'right')
          if (askW >= 14) drawLabel(ctx, fmtVol(ask), mid + sideGap + askW / 2, cy, 'center')
          else if (ask > 0) drawLabel(ctx, fmtVol(ask), mid + sideGap + 2, cy, 'left')
        }
      } else if (mode === 'delta') {
        const dW = profileW(Math.abs(delta), maxAbsD, maxFull)
        hbar(ctx, x0, top, dW, cellH, isPoc || isMaxD ? COL.poc : delta >= 0 ? COL.pos : COL.neg)
        if (showTxt && dW >= 16) drawLabel(ctx, fmtDelta(delta), x0 + dW / 2, cy, 'center')
        else if (showTxt) drawLabel(ctx, fmtDelta(delta), x0 + Math.max(dW, 4) + 2, cy, 'left')
      } else {
        const volW = profileW(tot, maxVol, maxFull)
        hbar(ctx, x0, top, volW, cellH, isPoc ? COL.poc : COL.vol)
        if (showTxt && volW >= 16) drawLabel(ctx, fmtVol(tot), x0 + volW / 2, cy, 'center')
        else if (showTxt) drawLabel(ctx, fmtVol(tot), x0 + Math.max(volW, 4) + 2, cy, 'left')
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
  const tickRef = useRef(0.01)
  const modeRef = useRef(mode)
  const unitRef = useRef(unit)
  modeRef.current = mode
  unitRef.current = unit
  const binSafe = Math.max(1, Math.round(Number(binMult) || 1))

  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    const canvas = canvasRef.current
    if (!show || !chart || !series || !canvas) {
      setHint(null)
      barsRef.current = []
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
      })
      return
    }

    let timer: number | null = null
    let aborted = false
    const ac = { current: new AbortController() }

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
      )
    }

    const load = () => {
      const ts = chart.timeScale()
      const log = ts.getVisibleLogicalRange()
      const host = wrapRef.current
      if (!log || !host || !barTimes.length) return
      const barPx = Math.max(1, (host.clientWidth - 56) / Math.max(1, log.to - log.from))
      const nBars = log.to - log.from
      if (barPx < FOOTPRINT_MIN_BAR_PX || nBars > FOOTPRINT_MAX_BARS) {
        ac.current.abort()
        ac.current = new AbortController()
        barsRef.current = []
        setHint('Zoom in for footprint')
        series.applyOptions({
          upColor: '#3fb950',
          downColor: '#f85149',
          wickUpColor: '#3fb950',
          wickDownColor: '#f85149',
        })
        paint()
        return
      }
      setHint('Loading footprint…')
      const fromIdx = Math.max(0, Math.floor(log.from))
      const toIdx = Math.min(barTimes.length - 1, Math.ceil(log.to))
      const t0 = barTimes[fromIdx]
      const t1 = barTimes[toIdx] + tf * 60
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return
      ac.current.abort()
      ac.current = new AbortController()
      void fetchFootprint({ symbol, tf, t0, t1, bin_mult: binSafe }, ac.current.signal)
        .then((r) => {
          if (aborted) return
          if (!r.ok || r.reason === 'zoom_in') {
            barsRef.current = []
            setHint('Zoom in for footprint')
            series.applyOptions({
              upColor: '#3fb950',
              downColor: '#f85149',
            })
            paint()
            return
          }
          barsRef.current = r.bars || []
          tickRef.current = Number(r.tick_size || 0.01)
          setHint(barsRef.current.length ? null : 'No ticks in view')
          series.applyOptions({
            upColor: 'rgba(63,185,80,0.04)',
            downColor: 'rgba(248,81,73,0.04)',
            wickUpColor: 'rgba(63,185,80,0.35)',
            wickDownColor: 'rgba(248,81,73,0.35)',
            borderVisible: false,
          })
          paint()
        })
        .catch((e) => {
          if (aborted || (e instanceof DOMException && e.name === 'AbortError')) return
          barsRef.current = []
          setHint(String(e.message || e))
          paint()
        })
    }

    const schedule = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(load, 220)
      paint()
    }

    load()
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule)
    window.addEventListener('resize', schedule)
    return () => {
      aborted = true
      ac.current.abort()
      if (timer != null) window.clearTimeout(timer)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [show, symbol, tf, binSafe, chartEpoch, chartRef, seriesRef, wrapRef, barTimes])

  useEffect(() => {
    if (!show) return
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
    )
  }, [show, mode, unit, tf])

  if (!show) return null

  return (
    <>
      <canvas className="footprint-canvas" ref={canvasRef} />
      {hint && <div className="footprint-hint">{hint}</div>}
    </>
  )
}
