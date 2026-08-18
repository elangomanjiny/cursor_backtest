import { useEffect, useRef } from 'react'
import {
  BaselineSeries,
  AreaSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type Time,
} from 'lightweight-charts'
import type { DashboardModel, EquityPoint, MarkerPoint } from './computeDashboard'
import { fmt2 } from '../format'

type Props = {
  model: DashboardModel
  visible?: boolean
}

const EQ_POS = '#22c55e'
const EQ_NEG = '#ef4444'
const EQ_POS_FILL = 'rgba(34, 197, 94, 0.35)'
const EQ_POS_FADE = 'rgba(34, 197, 94, 0.0)'
const EQ_NEG_FILL = 'rgba(239, 68, 68, 0.35)'
const EQ_NEG_FADE = 'rgba(239, 68, 68, 0.0)'
const DD = '#f87171'
const DD_FILL_TOP = 'rgba(248, 113, 113, 0.02)'
const DD_FILL_BOT = 'rgba(248, 113, 113, 0.4)'
const GRID = 'rgba(63, 63, 70, 0.45)'
const TEXT = '#a1a1aa'
const CROSS = 'rgba(56, 189, 248, 0.55)'

function fmtTipTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

function nearestExit(markers: MarkerPoint[], t: number): MarkerPoint | null {
  let best: MarkerPoint | null = null
  let bestD = Infinity
  for (const m of markers) {
    if (m.kind !== 'exit') continue
    const d = Math.abs(m.time - t)
    if (d < bestD) {
      best = m
      bestD = d
    }
  }
  return best
}

/**
 * Modern high-speed equity + underwater chart (lightweight-charts canvas).
 * Optimized for mouse-wheel scroll / pan — minimal markers, throttled tooltips.
 */
export function SyncedDepthCharts({ model, visible = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const tipRaf = useRef(0)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    el.innerHTML = ''

    const hostH = Math.max(220, el.clientHeight || 420)
    const chart = createChart(el, {
      layout: {
        background: { color: '#09090b' },
        textColor: TEXT,
        fontFamily: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      rightPriceScale: {
        borderColor: '#3f3f46',
        scaleMargins: { top: 0.1, bottom: 0.06 },
        minimumWidth: 56,
      },
      timeScale: {
        borderColor: '#3f3f46',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
      },
      crosshair: {
        mode: 0,
        vertLine: {
          color: CROSS,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#18181b',
        },
        horzLine: {
          color: 'rgba(161, 161, 170, 0.4)',
          width: 1,
          style: LineStyle.Dotted,
          labelBackgroundColor: '#18181b',
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
      height: hostH,
      width: Math.max(280, el.clientWidth || 480),
    })
    chartRef.current = chart

    const eqData = model.equity.map((e) => ({ time: e.time as Time, value: e.equity }))
    const ddData = model.equity.map((e) => ({
      time: e.time as Time,
      value: Math.min(0, e.drawdownPct),
    }))

    const eqSeries = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      relativeGradient: true,
      topLineColor: EQ_POS,
      bottomLineColor: EQ_NEG,
      topFillColor1: EQ_POS_FILL,
      topFillColor2: EQ_POS_FADE,
      bottomFillColor1: EQ_NEG_FADE,
      bottomFillColor2: EQ_NEG_FILL,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
      title: 'Equity',
    })
    eqSeries.setData(eqData)
    eqSeries.createPriceLine({
      price: 0,
      color: 'rgba(56, 189, 248, 0.65)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '0',
    })

    const ddPane = chart.addPane(true)
    ddPane.setHeight(Math.max(90, Math.round(hostH * 0.28)))
    try {
      ddPane.priceScale('right').applyOptions({
        scaleMargins: { top: 0.08, bottom: 0.1 },
        borderColor: '#3f3f46',
      })
    } catch {
      /* ignore */
    }

    const ddSeries = chart.addSeries(
      AreaSeries,
      {
        lineColor: DD,
        topColor: DD_FILL_TOP,
        bottomColor: DD_FILL_BOT,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
        title: 'DD%',
      },
      1,
    )
    ddSeries.setData(ddData)

    // Exit markers only (no text) — keeps wheel scroll smooth
    const exits = model.markers.filter((m) => m.kind === 'exit').slice(0, 80)
    if (exits.length) {
      createSeriesMarkers(
        eqSeries,
        exits.map((m) => ({
          time: m.time as Time,
          position: 'inBar' as const,
          color: m.win ? EQ_POS : EQ_NEG,
          shape: 'circle' as const,
          size: 0.55,
        })),
      )
    }

    const byTime = new Map<number, EquityPoint>()
    for (const e of model.equity) byTime.set(e.time, e)

    const onMove = (param: {
      point?: { x: number; y: number }
      time?: Time
    }) => {
      cancelAnimationFrame(tipRaf.current)
      tipRaf.current = requestAnimationFrame(() => {
        const tip = tipRef.current
        if (!tip) return
        if (!param.point || param.time === undefined) {
          tip.style.display = 'none'
          return
        }
        const t = param.time as number
        const pt = byTime.get(t)
        if (!pt) {
          tip.style.display = 'none'
          return
        }
        const trade = nearestExit(model.markers, t)
        const near = trade && Math.abs(trade.time - t) <= 120
        tip.style.display = 'block'
        tip.style.left = `${Math.min(el.clientWidth - 170, param.point.x + 12)}px`
        tip.style.top = `${Math.max(8, param.point.y - 8)}px`
        tip.innerHTML = `<div class="pod-tip-date">${fmtTipTime(pt.time)}</div>
          <div>Equity <b class="${pt.equity >= 0 ? 'pos' : 'neg'}">${fmt2(pt.equity)}</b></div>
          <div>DD <b class="neg">${fmt2(pt.drawdownPct)}%</b></div>
          ${
            near && trade
              ? `<div class="pod-tip-trade">${trade.win ? 'W' : 'L'} ${trade.side} · ${fmt2(trade.pnl)}</div>`
              : ''
          }`
      })
    }
    chart.subscribeCrosshairMove(onMove as never)

    const fit = () => {
      if (el.clientWidth < 2) return
      const h = el.clientHeight || 420
      chart.applyOptions({ width: el.clientWidth, height: h })
      try {
        ddPane.setHeight(Math.max(90, Math.round(h * 0.28)))
      } catch {
        /* ignore */
      }
    }
    fit()
    chart.timeScale().fitContent()
    chart.timeScale().applyOptions({ rightOffset: 6 })
    const ro = new ResizeObserver(() => fit())
    ro.observe(el)

    return () => {
      cancelAnimationFrame(tipRaf.current)
      ro.disconnect()
      chart.unsubscribeCrosshairMove(onMove as never)
      chart.remove()
      chartRef.current = null
    }
  }, [model])

  useEffect(() => {
    if (!visible) return
    const el = hostRef.current
    const chart = chartRef.current
    if (!el || !chart) return
    requestAnimationFrame(() => {
      if (el.clientWidth < 2) return
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight || 420 })
    })
  }, [visible])

  return (
    <div className="pod-depth-charts equity-fast-chart">
      <div className="pod-depth-host" ref={hostRef} />
      <div className="pod-tip" ref={tipRef} style={{ display: 'none' }} />
      <div className="pod-depth-legend">
        <span>
          <i style={{ background: `linear-gradient(90deg, ${EQ_POS}, ${EQ_NEG})` }} /> Equity ≥0
          green / &lt;0 red
        </span>
        <span>
          <i style={{ background: DD }} /> Underwater DD%
        </span>
        <span className="hint" style={{ margin: 0 }}>
          Scroll / drag to pan · wheel+ctrl to zoom
        </span>
      </div>
    </div>
  )
}
