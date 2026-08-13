import { useEffect, useRef } from 'react'
import {
  BaselineSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import type { DashboardModel, EquityPoint, MarkerPoint } from './computeDashboard'
import { FT } from './theme'
import { fmt2 } from '../format'

type Props = {
  model: DashboardModel
  visible?: boolean
}

const EQ_GREEN = '#22c55e'
const EQ_RED = '#ef4444'
const EQ_GREEN_FILL = 'rgba(34, 197, 94, 0.35)'
const EQ_GREEN_FADE = 'rgba(34, 197, 94, 0.0)'
const EQ_RED_FILL = 'rgba(239, 68, 68, 0.35)'
const EQ_RED_FADE = 'rgba(239, 68, 68, 0.0)'
const BASELINE = 'rgba(103, 232, 249, 0.72)'
const RIBBON_SHADOW = 'rgba(2, 8, 16, 0.72)'
const RIBBON_GLOW = 'rgba(34, 197, 94, 0.22)'

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

function ribbonOffset(equity: EquityPoint[]): number {
  if (!equity.length) return 0.01
  let lo = equity[0].equity
  let hi = equity[0].equity
  for (const e of equity) {
    lo = Math.min(lo, e.equity)
    hi = Math.max(hi, e.equity)
  }
  const span = Math.max(Math.abs(hi - lo), Math.abs(hi), Math.abs(lo), 1e-6)
  return span * 0.028
}

function nearestTrade(markers: MarkerPoint[], t: number): MarkerPoint | null {
  if (!markers.length) return null
  let best = markers[0]
  let bestD = Math.abs(markers[0].time - t)
  for (const m of markers) {
    const d = Math.abs(m.time - t)
    if (d < bestD) {
      best = m
      bestD = d
    }
  }
  // Only attach when hover is near a trade stamp (~1 bar window handled by caller)
  return best
}

/** Dual-pane equity ribbon + underwater DD with zero-baseline color split. */
export function SyncedDepthCharts({ model, visible = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const eqSeriesRef = useRef<ISeriesApi<'Baseline'> | null>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    el.innerHTML = ''

    const hostH = Math.max(200, el.clientHeight || 420)
    const chart = createChart(el, {
      layout: {
        background: { color: 'transparent' },
        textColor: FT.muted,
        fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(56, 189, 248, 0.07)' },
        horzLines: { color: 'rgba(80, 100, 130, 0.18)' },
      },
      rightPriceScale: {
        borderColor: FT.border,
        scaleMargins: { top: 0.08, bottom: 0.1 },
      },
      timeScale: {
        borderColor: FT.border,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: 0,
        vertLine: {
          color: 'rgba(103, 232, 249, 0.55)',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: FT.panelSolid,
        },
        horzLine: {
          color: 'rgba(148, 163, 184, 0.45)',
          width: 1,
          style: LineStyle.Dotted,
          labelBackgroundColor: FT.panelSolid,
        },
      },
      height: hostH,
      width: Math.max(280, el.clientWidth || 480),
    })
    chartRef.current = chart

    const eqData = model.equity.map((e) => ({ time: e.time as Time, value: e.equity }))
    const offset = ribbonOffset(model.equity)
    const shadowData = model.equity.map((e) => ({
      time: e.time as Time,
      value: e.equity - offset,
    }))

    // Soft glow ribbon underlay (depth)
    const glowSeries = chart.addSeries(LineSeries, {
      color: RIBBON_GLOW,
      lineWidth: 4,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      pointMarkersVisible: false,
    })
    glowSeries.setData(eqData)

    // Isometric extrusion / drop-shadow ribbon
    const shadowSeries = chart.addSeries(LineSeries, {
      color: RIBBON_SHADOW,
      lineWidth: 4,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      pointMarkersVisible: false,
    })
    shadowSeries.setData(shadowData)

    // Primary zero-split baseline ribbon
    const eqSeries = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      relativeGradient: true,
      topLineColor: EQ_GREEN,
      bottomLineColor: EQ_RED,
      topFillColor1: EQ_GREEN_FILL,
      topFillColor2: EQ_GREEN_FADE,
      bottomFillColor1: EQ_RED_FADE,
      bottomFillColor2: EQ_RED_FILL,
      lineWidth: 3,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 6,
      crosshairMarkerBorderWidth: 2,
      crosshairMarkerBorderColor: '#e8eef6',
      crosshairMarkerBackgroundColor: EQ_GREEN,
      title: 'PnL',
    })
    eqSeriesRef.current = eqSeries
    eqSeries.setData(eqData)

    eqSeries.createPriceLine({
      price: 0,
      color: BASELINE,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '0.00',
    })

    const ddPane = chart.addPane(true)
    ddPane.setHeight(Math.max(120, Math.round(hostH * 0.34)))
    try {
      ddPane.priceScale('right').applyOptions({
        scaleMargins: { top: 0.05, bottom: 0.12 },
        borderColor: FT.border,
      })
    } catch {
      /* older pane API */
    }

    // Underwater DD% — always ≤ 0, crimson depth fill to zero baseline
    const ddSeries = chart.addSeries(
      BaselineSeries,
      {
        baseValue: { type: 'price', price: 0 },
        relativeGradient: true,
        topLineColor: 'rgba(239, 68, 68, 0.15)',
        bottomLineColor: '#b91c1c',
        topFillColor1: 'rgba(239, 68, 68, 0)',
        topFillColor2: 'rgba(239, 68, 68, 0)',
        bottomFillColor1: 'rgba(127, 29, 29, 0.05)',
        bottomFillColor2: 'rgba(239, 68, 68, 0.42)',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
        crosshairMarkerBorderColor: '#fecaca',
        crosshairMarkerBackgroundColor: EQ_RED,
        title: 'DD %',
      },
      1,
    )
    ddSeries.setData(
      model.equity.map((e) => ({
        time: e.time as Time,
        value: Math.min(0, e.drawdownPct),
      })),
    )
    ddSeries.createPriceLine({
      price: 0,
      color: 'rgba(148, 163, 184, 0.55)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '0%',
    })

    const tradeMarkers = model.markers
    createSeriesMarkers(
      eqSeries,
      tradeMarkers.map((m) => ({
        time: m.time as Time,
        position: 'atPriceMiddle' as const,
        price: m.equity,
        color: m.win ? EQ_GREEN : EQ_RED,
        shape: 'circle' as const,
        size: m.kind === 'exit' ? 1.55 : 1.05,
        text: m.kind === 'exit' ? (m.win ? 'W' : 'L') : undefined,
      })),
    )

    const byTime = new Map<number, EquityPoint>()
    for (const e of model.equity) byTime.set(e.time, e)

    const onMove = (param: {
      point?: { x: number; y: number }
      time?: Time
      seriesData?: Map<unknown, { value?: number }>
    }) => {
      const tip = tipRef.current
      if (!tip) return
      if (!param.point || param.time === undefined) {
        tip.style.display = 'none'
        return
      }
      const t = param.time as number
      const pt =
        byTime.get(t) ||
        model.equity.reduce((best, e) => {
          if (!best) return e
          return Math.abs(e.time - t) < Math.abs(best.time - t) ? e : best
        }, null as EquityPoint | null)
      if (!pt) {
        tip.style.display = 'none'
        return
      }

      const eqPos = pt.equity >= 0
      const eqColor = eqPos ? EQ_GREEN : EQ_RED
      try {
        eqSeries.applyOptions({
          crosshairMarkerBackgroundColor: eqColor,
          crosshairMarkerBorderColor: eqPos ? '#bbf7d0' : '#fecaca',
        })
      } catch {
        /* ignore */
      }

      const trade = nearestTrade(tradeMarkers, t)
      const nearTrade = trade && Math.abs(trade.time - t) <= 90
      const tradeHtml = nearTrade
        ? `<div class="pod-tip-trade ${trade.win ? 'pos' : 'neg'}">
            ${trade.kind === 'entry' ? 'Entry' : 'Exit'} ${String(trade.side)} ·
            PnL <b>${fmt2(trade.pnl)}</b>
          </div>`
        : ''

      tip.style.display = 'block'
      tip.style.left = `${Math.min(el.clientWidth - 190, param.point.x + 14)}px`
      tip.style.top = `${Math.max(10, param.point.y - 10)}px`
      tip.innerHTML = `
        <div class="pod-tip-date">${fmtTipTime(pt.time)}</div>
        <div>Equity <b style="color:${eqColor}">${fmt2(pt.equity)}</b></div>
        <div>Drawdown <b class="neg">${fmt2(pt.drawdownPct)}%</b></div>
        <div>Cum return <b>${fmt2(pt.cumReturnPct)}%</b></div>
        ${tradeHtml}
      `
    }
    chart.subscribeCrosshairMove(onMove as never)

    const fit = () => {
      if (el.clientWidth < 2) return
      const h = el.clientHeight || 420
      chart.applyOptions({
        width: el.clientWidth,
        height: h,
      })
      try {
        ddPane.setHeight(Math.max(120, Math.round(h * 0.34)))
      } catch {
        /* pane may be gone during teardown */
      }
    }
    fit()
    chart.timeScale().fitContent()
    const ro = new ResizeObserver(() => fit())
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.unsubscribeCrosshairMove(onMove as never)
      chart.remove()
      chartRef.current = null
      eqSeriesRef.current = null
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
    <div className="pod-depth-charts pod-depth-charts-3d">
      <div className="pod-depth-plane" aria-hidden />
      <div className="pod-depth-glow" aria-hidden />
      <div className="pod-depth-host" ref={hostRef} />
      <div className="pod-tip" ref={tipRef} style={{ display: 'none' }} />
      <div className="pod-depth-legend">
        <span>
          <i style={{ background: `linear-gradient(90deg, ${EQ_GREEN}, ${EQ_RED})` }} /> Equity ≥0
          green / &lt;0 red
        </span>
        <span>
          <i style={{ background: BASELINE }} /> Zero baseline
        </span>
        <span>
          <i style={{ background: EQ_RED }} /> Underwater DD%
        </span>
      </div>
    </div>
  )
}
