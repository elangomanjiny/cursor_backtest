import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type Time,
} from 'lightweight-charts'
import {
  computeDashboard,
  rangeBounds,
  type EquityPoint,
} from './computeDashboard'
import type { BacktestResult } from '../api'
import { MetricsGrid } from './MetricsGrid'
import { TV } from './theme'
import { fmt2 } from '../format'

type RangeKey = '1M' | '3M' | '6M' | 'YTD' | 'All'

type Props = {
  data: BacktestResult
  visible?: boolean
}

function fmtTime(sec: number): string {
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

export function EquityCurveChart({ data, visible = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const eqSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null)
  const bhSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null)
  const model = useMemo(() => computeDashboard(data), [data])
  const [logScale, setLogScale] = useState(false)
  const [showBh, setShowBh] = useState(true)
  const [range, setRange] = useState<RangeKey>('All')
  const [panelMax, setPanelMax] = useState(false)

  const canLog = useMemo(() => model.equity.every((e) => e.equity > 0), [model.equity])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    el.innerHTML = ''

    const chart = createChart(el, {
      layout: {
        background: { color: TV.bg },
        textColor: TV.muted,
      },
      grid: { vertLines: { color: TV.grid }, horzLines: { color: TV.grid } },
      rightPriceScale: { borderColor: TV.border },
      timeScale: { borderColor: TV.border, timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: TV.crosshair, labelBackgroundColor: TV.panel },
        horzLine: { color: TV.crosshair, labelBackgroundColor: TV.panel },
      },
      height: Math.max(320, el.clientHeight || 420),
      width: Math.max(320, el.clientWidth || 640),
    })
    chartRef.current = chart

    const eqSeries = chart.addSeries(AreaSeries, {
      lineColor: TV.green,
      topColor: TV.greenSoft,
      bottomColor: TV.greenFade,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    })
    eqSeriesRef.current = eqSeries

    const bhSeries = chart.addSeries(LineSeries, {
      color: TV.blueSoft,
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: 'Buy & hold',
    })
    bhSeriesRef.current = bhSeries

    const ddPane = chart.addPane(true)
    ddPane.setHeight(110)
    const ddSeries = chart.addSeries(
      AreaSeries,
      {
        lineColor: TV.red,
        topColor: TV.redFade,
        bottomColor: TV.redSoft,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'Drawdown %',
      },
      1,
    )

    const eqData = model.equity.map((e) => ({
      time: e.time as Time,
      value: e.equity,
    }))
    eqSeries.setData(eqData)
    ddSeries.setData(
      model.equity.map((e) => ({ time: e.time as Time, value: e.drawdownPct })),
    )
    if (model.buyHold.length) {
      bhSeries.setData(model.buyHold.map((p) => ({ time: p.time as Time, value: p.value })))
    } else {
      bhSeries.setData([])
    }

    const exitMarkers = model.markers
      .filter((m) => m.kind === 'exit')
      .map((m) => ({
        time: m.time as Time,
        position: 'inBar' as const,
        color: m.win ? TV.green : TV.red,
        shape: (m.win ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
        text: m.win ? 'W' : 'L',
      }))
    createSeriesMarkers(eqSeries, exitMarkers)

    const byTime = new Map<number, EquityPoint>()
    for (const e of model.equity) byTime.set(e.time, e)

    const onMove = (param: {
      point?: { x: number; y: number } | undefined
      time?: Time
      seriesData: Map<unknown, unknown>
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
      tip.style.display = 'block'
      tip.style.left = `${Math.min(el.clientWidth - 180, param.point.x + 12)}px`
      tip.style.top = `${Math.max(8, param.point.y - 8)}px`
      tip.innerHTML = `
        <div class="eq-tip-date">${fmtTime(pt.time)}</div>
        <div>Equity <b>${fmt2(pt.equity)}</b></div>
        <div>Drawdown <b class="neg">${fmt2(pt.drawdownPct)}%</b></div>
        <div>Cum return <b>${fmt2(pt.cumReturnPct)}%</b></div>
      `
    }
    chart.subscribeCrosshairMove(onMove as never)

    const fit = () => {
      const w = el.clientWidth
      const h = el.clientHeight || 420
      if (w < 2) return
      chart.applyOptions({ width: w, height: h })
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
      bhSeriesRef.current = null
    }
  }, [model])

  useEffect(() => {
    const chart = chartRef.current
    const series = eqSeriesRef.current
    if (!chart || !series) return
    const mode = logScale && canLog ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal
    series.priceScale().applyOptions({ mode })
  }, [logScale, canLog])

  useEffect(() => {
    const bh = bhSeriesRef.current
    if (!bh) return
    bh.applyOptions({ visible: showBh && model.buyHold.length > 0 })
  }, [showBh, model.buyHold.length])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const b = rangeBounds(model.equity, range)
    if (!b) return
    if (range === 'All') {
      chart.timeScale().fitContent()
      return
    }
    try {
      chart.timeScale().setVisibleRange({ from: b.from as Time, to: b.to as Time })
    } catch {
      chart.timeScale().fitContent()
    }
  }, [range, model.equity])

  useEffect(() => {
    if (!visible) return
    const el = hostRef.current
    const chart = chartRef.current
    if (!el || !chart) return
    requestAnimationFrame(() => {
      if (el.clientWidth < 2) return
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight || 420 })
    })
  }, [visible, panelMax])

  return (
    <div className={`equity-dashboard${panelMax ? ' panel-maximized' : ''}`}>
      <div className="equity-dash-toolbar">
        <div className="equity-range">
          {(['1M', '3M', '6M', 'YTD', 'All'] as RangeKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={range === k ? 'active' : ''}
              onClick={() => setRange(k)}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="equity-toggles">
          <label className="check">
            <input
              type="checkbox"
              checked={logScale}
              disabled={!canLog}
              onChange={(e) => setLogScale(e.target.checked)}
              title={canLog ? 'Log scale' : 'Log scale needs strictly positive equity'}
            />
            Log
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={showBh}
              disabled={!model.buyHold.length}
              onChange={(e) => setShowBh(e.target.checked)}
            />
            Buy &amp; hold
          </label>
          <button
            type="button"
            className="ghost panel-max-btn"
            title={panelMax ? 'Restore' : 'Maximize'}
            onClick={() => setPanelMax((v) => !v)}
          >
            {panelMax ? '❐' : '⛶'}
          </button>
        </div>
      </div>

      <div className="equity-dash-layout">
        <div className="equity-dash-chart-wrap">
          <div className="equity-dash-chart" ref={hostRef} />
          <div className="eq-tooltip" ref={tipRef} style={{ display: 'none' }} />
          <div className="equity-legend">
            <span>
              <i style={{ background: TV.green }} /> Strategy
            </span>
            <span>
              <i style={{ background: TV.blue }} /> Buy &amp; hold
            </span>
            <span>
              <i style={{ background: TV.red }} /> Drawdown
            </span>
            <span className="hint">Markers: green win / red loss exits · scroll zoom · drag pan</span>
          </div>
        </div>
        <aside className="equity-dash-side">
          <MetricsGrid metrics={model.metrics} />
        </aside>
      </div>
    </div>
  )
}
