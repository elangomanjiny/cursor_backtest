import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type HistogramData,
  type IChartApi,
  type IPaneApi,
} from '@stocksharp/chart'
import { fetchFlowStats, type FootprintBar, type OrderflowBar } from '../api'
import { attachCandlePricePan, resetPriceOnly } from '../chartPricePan'
import { computeVwap, parseBandMultipliers, type VwapSession, type VwapSource } from '../computeVwap'
import { FootprintOverlay, type CandleSeries, type FootprintMode } from '../FootprintOverlay'
import { fmt2 } from '../format'

export type PriceKind = 'candle' | 'bar' | 'line'
export type Unit = 'quote' | 'base'

type Props = {
  bars: OrderflowBar[]
  symbol: string
  tf: number
  visible?: boolean
}

const VWAP_COLOR = '#26a69a'
const VWAP_BAND_COLORS = ['#26a69a99', '#26a69a66', '#26a69a44']
const FLOW_MAX = 512
const RIGHT_PAD = 16

type HistKey = 'vol' | 'delta' | 'dp' | 'cvd' | 'min' | 'max' | 'ch' | 'cl'
const HIST_KEYS: HistKey[] = ['vol', 'delta', 'dp', 'cvd', 'min', 'max', 'ch', 'cl']
const HIST_LABEL: Record<HistKey, string> = {
  vol: 'Vol',
  delta: 'Δ',
  dp: 'Δ%',
  cvd: 'CVD',
  min: 'MinΔ',
  max: 'MaxΔ',
  ch: 'CH',
  cl: 'CL',
}

type HistHandle = { pane: IPaneApi; series: { setData: (d: readonly HistogramData[]) => void } }
type PaneLayout = { top: number; height: number; id: string; state: string }

function volOf(b: OrderflowBar, unit: Unit) {
  return unit === 'base' ? Number(b.volume_base || 0) : Number(b.volume_quote || 0)
}
function deltaOf(b: OrderflowBar, unit: Unit) {
  return unit === 'base' ? Number(b.delta_base || 0) : Number(b.delta_quote || 0)
}
function clsSigned(n: number) {
  if (n > 0) return 'pos'
  if (n < 0) return 'neg'
  return ''
}
function symbolTickSize(symbol: string): number {
  return (symbol || '').toUpperCase().startsWith('BTC') ? 0.1 : 0.01
}
function fmtTick(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n.toFixed(10).replace(/\.?0+$/, '')
}
function fmtPlot(v: number): string {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}m`
  if (a >= 1000) return `${(v / 1000).toFixed(1)}k`
  return fmt2(v)
}

function sessionCvd(bars: OrderflowBar[], unit: Unit): HistogramData[] {
  let cvd = 0
  let day = ''
  return bars.map((b) => {
    const d = new Date(b.time * 1000).toISOString().slice(0, 10)
    if (d !== day) {
      cvd = 0
      day = d
    }
    cvd += deltaOf(b, unit)
    return { time: b.time, value: cvd, color: cvd >= 0 ? '#3fb950' : '#f85149' }
  })
}

type Tip = {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  delta: number
  delta_pct: number
  cvd?: number
  vwap?: number
  minD?: number
  maxD?: number
  ch?: number
  cl?: number
}

export function OrderflowChart({ bars, symbol, tf, visible = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<CandleSeries | null>(null)
  const histRef = useRef<Partial<Record<HistKey, HistHandle>>>({})
  const panesRef = useRef<IPaneApi[]>([])
  const rangeRef = useRef<{ from: number; to: number } | null>(null)
  const [chartEpoch, setChartEpoch] = useState(0)
  const [unit, setUnit] = useState<Unit>('quote')
  const [priceKind, setPriceKind] = useState<PriceKind>('candle')
  const [fpMode, setFpMode] = useState<FootprintMode>('profile')
  const [fpBinMult, setFpBinMult] = useState(1)
  const [showFootprint, setShowFootprint] = useState(true)
  const [showVaz, setShowVaz] = useState(true)
  const [showCot, setShowCot] = useState(true)
  const [showMinMax, setShowMinMax] = useState(true)
  const [showVwap, setShowVwap] = useState(false)
  const [showLegend, setShowLegend] = useState(false)
  const [showHoverTip, setShowHoverTip] = useState(true)
  const [paneOn, setPaneOn] = useState<Record<HistKey, boolean>>({
    vol: true,
    delta: true,
    dp: true,
    cvd: false,
    min: false,
    max: false,
    ch: false,
    cl: false,
  })
  const paneOnRef = useRef(paneOn)
  paneOnRef.current = paneOn
  const [rightOpen, setRightOpen] = useState(false)
  const [rightPinned, setRightPinned] = useState(false)
  const [vwapSource] = useState<VwapSource>('hlc3')
  const [vwapSession] = useState<VwapSession>('binance')
  const [tip, setTip] = useState<Tip | null>(null)
  const [flow, setFlow] = useState<FootprintBar[]>([])
  const [paneLayouts, setPaneLayouts] = useState<PaneLayout[]>([])
  const flowAc = useRef<AbortController | null>(null)

  const binSafe = Math.max(1, Math.round(fpBinMult) || 1)
  const unitLabel = unit === 'quote' ? 'USDT' : 'BASE'
  const kind = showFootprint ? 'candle' : priceKind

  const vwapSettings = useMemo(
    () => ({ source: vwapSource, session: vwapSession, bands: parseBandMultipliers('1,2') }),
    [vwapSource, vwapSession],
  )
  const asBarRows = useMemo(
    () =>
      bars.map((b) => ({
        time: b.time,
        time_iso: b.time_iso,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume_quote,
        delta: b.delta_quote,
        volume_quote: b.volume_quote,
        volume_base: b.volume_base,
        delta_quote: b.delta_quote,
        delta_base: b.delta_base,
        delta_pct: b.delta_pct,
        events: [] as string[],
      })),
    [bars],
  )
  const vwapSeries = useMemo(() => {
    if (!showVwap) return []
    return computeVwap(asBarRows, unit, vwapSettings)
  }, [asBarRows, showVwap, unit, vwapSettings])
  const barTimes = useMemo(() => bars.map((b) => b.time), [bars])
  const byTime = useMemo(() => {
    const m = new Map<number, OrderflowBar>()
    for (const b of bars) m.set(b.time, b)
    return m
  }, [bars])
  const flowByTime = useMemo(() => {
    const m = new Map<number, FootprintBar>()
    for (const f of flow) m.set(f.time, f)
    return m
  }, [flow])
  const cvdByTime = useMemo(() => {
    const m = new Map<number, number>()
    for (const p of sessionCvd(bars, unit)) m.set(Number(p.time), Number(p.value))
    return m
  }, [bars, unit])
  const hoverRef = useRef({ byTime, flowByTime, cvdByTime, unit, vwapSeries, showVwap })
  hoverRef.current = { byTime, flowByTime, cvdByTime, unit, vwapSeries, showVwap }

  const lastBar = bars[bars.length - 1]
  const lastFlow = lastBar ? flowByTime.get(lastBar.time) : undefined
  const inspect: Tip | null = tip ?? (lastBar
    ? {
        time: lastBar.time_iso,
        open: lastBar.open,
        high: lastBar.high,
        low: lastBar.low,
        close: lastBar.close,
        volume: volOf(lastBar, unit),
        delta: deltaOf(lastBar, unit),
        delta_pct: lastBar.delta_pct,
        cvd: cvdByTime.get(lastBar.time),
        minD: unit === 'quote' ? lastFlow?.minDeltaQuote : lastFlow?.minDelta,
        maxD: unit === 'quote' ? lastFlow?.maxDeltaQuote : lastFlow?.maxDelta,
        ch: unit === 'quote' ? lastFlow?.cotHighQuote : lastFlow?.cotHigh,
        cl: unit === 'quote' ? lastFlow?.cotLowQuote : lastFlow?.cotLow,
      }
    : null)

  useEffect(() => {
    if (!bars.length) return
    const n = bars.length
    const slice = n > FLOW_MAX ? bars.slice(n - FLOW_MAX) : bars
    const t0 = slice[0].time
    const t1 = slice[slice.length - 1].time + tf * 60
    flowAc.current?.abort()
    const ac = new AbortController()
    flowAc.current = ac
    void fetchFlowStats({ symbol, tf, t0, t1 }, ac.signal)
      .then((r) => {
        if (!ac.signal.aborted) setFlow(r.bars || [])
      })
      .catch(() => {
        if (!ac.signal.aborted) setFlow([])
      })
    return () => ac.abort()
  }, [bars, symbol, tf])

  const histData = (key: HistKey): HistogramData[] => {
    const signed = (v: number) => (v >= 0 ? '#3fb950' : '#f85149')
    if (key === 'vol') {
      return bars.map((b) => ({
        time: b.time,
        value: volOf(b, unit),
        color: b.close >= b.open ? '#3fb95088' : '#f8514988',
      }))
    }
    if (key === 'delta') {
      return bars.map((b) => {
        const v = deltaOf(b, unit)
        return { time: b.time, value: v, color: signed(v) }
      })
    }
    if (key === 'dp') {
      return bars.map((b) => ({
        time: b.time,
        value: b.delta_pct,
        color: signed(b.delta_pct),
      }))
    }
    if (key === 'cvd') return sessionCvd(bars, unit)
    const pick = (f: FootprintBar) => {
      if (key === 'min') return unit === 'quote' ? Number(f.minDeltaQuote || 0) : Number(f.minDelta || 0)
      if (key === 'max') return unit === 'quote' ? Number(f.maxDeltaQuote || 0) : Number(f.maxDelta || 0)
      if (key === 'ch') return unit === 'quote' ? Number(f.cotHighQuote || 0) : Number(f.cotHigh || 0)
      return unit === 'quote' ? Number(f.cotLowQuote || 0) : Number(f.cotLow || 0)
    }
    return flow.map((f) => ({ time: f.time, value: pick(f), color: signed(pick(f)) }))
  }

  const applyPaneVis = () => {
    const on = paneOnRef.current
    for (const key of HIST_KEYS) {
      const h = histRef.current[key]
      if (!h) continue
      try {
        const cur = String(h.pane.options().state)
        if (!on[key]) {
          if (cur !== 'minimized') h.pane.applyOptions({ state: 'minimized' })
        } else if (cur === 'minimized') {
          h.pane.applyOptions({ state: 'normal' })
        }
      } catch {
        /* ignore */
      }
    }
  }

  const syncPaneOverlays = () => {
    const chart = chartRef.current
    if (!chart) {
      setPaneLayouts([])
      return
    }
    try {
      const panes = chart.panes()
      panesRef.current = [...panes]
      setPaneLayouts(
        panes.map((p) => {
          const size = p.getSize()
          return { id: p.id(), top: size.top, height: size.height, state: String(p.options().state) }
        }),
      )
      const nav = navRef.current
      const main = panes[0]?.getSize()
      if (nav && main && main.height > 40) {
        nav.style.top = `${main.top + main.height - 44}px`
        nav.style.bottom = 'auto'
        nav.style.display = ''
      }
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    const el = hostRef.current
    if (!el || !bars.length) return
    const saved = rangeRef.current
    el.innerHTML = ''
    const chart = createChart(el, {
      layout: { background: { type: 'solid', color: '#0f1419' }, textColor: '#8b949e' },
      grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
      timeScale: {
        borderColor: '#30363d',
        timeVisible: true,
        timeZone: 'Asia/Kolkata',
        locale: 'en-IN',
      },
      rightPriceScale: { borderColor: '#30363d', scaleMargins: { top: 0.06, bottom: 0.08 } },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true },
    })
    chartRef.current = chart

    const hollow = kind === 'bar'
    const hideBody = kind === 'line'
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: hideBody ? 'rgba(0,0,0,0)' : hollow ? 'rgba(0,0,0,0)' : '#3fb950',
      downColor: hideBody ? 'rgba(0,0,0,0)' : hollow ? 'rgba(0,0,0,0)' : '#f85149',
      borderVisible: hollow && !hideBody,
      borderUpColor: '#3fb950',
      borderDownColor: '#f85149',
      wickUpColor: hideBody ? 'rgba(0,0,0,0)' : '#3fb950',
      wickDownColor: hideBody ? 'rgba(0,0,0,0)' : '#f85149',
    })
    seriesRef.current = candles
    candles.setData(
      bars.map((b) => ({
        time: b.time as never,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    )
    if (kind === 'line') {
      const line = chart.addSeries(LineSeries, {
        color: '#58a6ff',
        lineWidth: 2,
        lastValueVisible: true,
        priceLineVisible: false,
      })
      line.setData(bars.map((b) => ({ time: b.time as never, value: b.close })))
    }

    if (showVwap && vwapSeries.length) {
      const vwapLine = chart.addSeries(LineSeries, {
        color: VWAP_COLOR,
        lineWidth: 2,
        lastValueVisible: true,
        priceLineVisible: false,
      })
      vwapLine.setData(vwapSeries.map((p) => ({ time: p.time as never, value: p.vwap })))
      vwapSettings.bands.forEach((mult, i) => {
        const color = VWAP_BAND_COLORS[Math.min(i, VWAP_BAND_COLORS.length - 1)]
        const up = chart.addSeries(LineSeries, {
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          lastValueVisible: false,
          priceLineVisible: false,
        })
        const dn = chart.addSeries(LineSeries, {
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          lastValueVisible: false,
          priceLineVisible: false,
        })
        up.setData(vwapSeries.map((p) => ({ time: p.time as never, value: p.bands[`up${mult}`] })))
        dn.setData(vwapSeries.map((p) => ({ time: p.time as never, value: p.bands[`dn${mult}`] })))
      })
    }

    const handles: Partial<Record<HistKey, HistHandle>> = {}
    for (const key of HIST_KEYS) {
      const pane = chart.addPane({ height: 56, minHeight: 22 })
      const series = pane.addSeries(HistogramSeries, { color: '#3fb950', priceFormat: { type: 'volume' } })
      series.setData(histData(key))
      handles[key] = { pane, series }
    }
    histRef.current = handles
    applyPaneVis()

    try {
      const main = chart.panes()[0]
      main?.applyOptions({ minHeight: 80, height: Math.max(180, main.options().height || 240) })
    } catch {
      /* ignore */
    }

    const onMove = (param: { time?: unknown; point?: { x: number; y: number } | undefined }) => {
      const ctx = hoverRef.current
      if (!param.time || param.point === undefined) {
        setTip(null)
        return
      }
      const t = Number(param.time)
      const b = ctx.byTime.get(t)
      if (!b) {
        setTip(null)
        return
      }
      const f = ctx.flowByTime.get(t)
      const vp = ctx.showVwap ? ctx.vwapSeries.find((p) => p.time === t) : undefined
      const u = ctx.unit
      setTip({
        time: b.time_iso,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: volOf(b, u),
        delta: deltaOf(b, u),
        delta_pct: b.delta_pct,
        cvd: ctx.cvdByTime.get(t),
        vwap: vp?.vwap,
        minD: u === 'quote' ? f?.minDeltaQuote : f?.minDelta,
        maxD: u === 'quote' ? f?.maxDeltaQuote : f?.maxDelta,
        ch: u === 'quote' ? f?.cotHighQuote : f?.cotHigh,
        cl: u === 'quote' ? f?.cotLowQuote : f?.cotLow,
      })
    }
    chart.subscribeCrosshairMove(onMove as never)
    const onRange = () => {
      const r = chart.timeScale().getVisibleLogicalRange()
      if (r) rangeRef.current = { from: r.from, to: r.to }
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    const onResize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w < 8 || h < 8) return
      chart.applyOptions({ width: w, height: h })
      chart.resize(w, h)
      requestAnimationFrame(syncPaneOverlays)
    }
    onResize()
    requestAnimationFrame(() => {
      onResize()
      const ts = chart.timeScale()
      if (saved) {
        try {
          ts.setVisibleLogicalRange(saved)
        } catch {
          ts.fitContent()
        }
      } else {
        ts.fitContent()
        const r = ts.getVisibleLogicalRange()
        if (r) ts.setVisibleLogicalRange({ from: r.from, to: r.to + RIGHT_PAD })
      }
      requestAnimationFrame(syncPaneOverlays)
    })
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(() => onResize())
    ro.observe(el)
    const detachPricePan = attachCandlePricePan(chart, el)
    setChartEpoch((n) => n + 1)

    return () => {
      const r = chart.timeScale().getVisibleLogicalRange()
      if (r) rangeRef.current = { from: r.from, to: r.to }
      ro.disconnect()
      detachPricePan()
      window.removeEventListener('resize', onResize)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      chart.unsubscribeCrosshairMove(onMove as never)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      histRef.current = {}
      panesRef.current = []
    }
    // Pane toggles and flow updates must NOT recreate the chart (that resets zoom).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, kind, showVwap, vwapSettings, unit])

  useEffect(() => {
    applyPaneVis()
    requestAnimationFrame(syncPaneOverlays)
  }, [paneOn])

  useEffect(() => {
    if (!visible) return
    const el = hostRef.current
    const chart = chartRef.current
    if (!el || !chart) return
    const w = el.clientWidth
    const h = el.clientHeight
    if (w < 8 || h < 8) return
    chart.applyOptions({ width: w, height: h })
    chart.resize(w, h)
    requestAnimationFrame(syncPaneOverlays)
  }, [visible])

  useEffect(() => {
    for (const key of HIST_KEYS) {
      histRef.current[key]?.series.setData(histData(key))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, unit, flow])

  const zoom = (factor: number) => {
    const ts = chartRef.current?.timeScale()
    const range = ts?.getVisibleLogicalRange()
    if (!ts || !range) return
    const mid = (range.from + range.to) / 2
    const half = ((range.to - range.from) / 2) * factor
    ts.setVisibleLogicalRange({ from: mid - half, to: mid + half })
  }
  const reset = () => {
    const ts = chartRef.current?.timeScale()
    ts?.fitContent()
    const r = ts?.getVisibleLogicalRange()
    if (r) ts?.setVisibleLogicalRange({ from: r.from, to: r.to + RIGHT_PAD })
  }
  const resetY = () => {
    const chart = chartRef.current
    if (chart) resetPriceOnly(chart)
  }
  const end = () => {
    chartRef.current?.timeScale().scrollToRealTime()
  }
  const offsetRight = () => {
    const ts = chartRef.current?.timeScale()
    const r = ts?.getVisibleLogicalRange()
    if (ts && r) ts.setVisibleLogicalRange({ from: r.from, to: r.to + RIGHT_PAD })
  }

  const setPaneState = (paneId: string, state: 'normal' | 'minimized' | 'maximized') => {
    const panes = panesRef.current
    const pane = panes.find((p) => p.id() === paneId)
    if (!pane) return
    const priceId = panes[0]?.id()
    try {
      if (paneId === priceId && state === 'maximized') {
        const rest = panes.slice(1)
        const collapsed = rest.length > 0 && rest.every((p) => p.options().state === 'minimized')
        if (collapsed) {
          applyPaneVis()
        } else {
          for (const key of HIST_KEYS) {
            try {
              histRef.current[key]?.pane.applyOptions({ state: 'minimized' })
            } catch {
              /* ignore */
            }
          }
        }
        requestAnimationFrame(syncPaneOverlays)
        return
      }
      const cur = pane.options().state
      const next = cur === state ? 'normal' : state
      if (next === 'maximized') {
        for (const p of panes) {
          if (p.id() !== paneId && p.options().state === 'maximized') p.applyOptions({ state: 'normal' })
        }
      }
      pane.applyOptions({ state: next })
      requestAnimationFrame(syncPaneOverlays)
    } catch {
      /* ignore */
    }
  }

  const paneNames = ['Price', ...HIST_KEYS.map((k) => HIST_LABEL[k])]
  const priceOnly =
    paneLayouts.length > 1 && paneLayouts.slice(1).every((p) => p.state === 'minimized')
  const bull = inspect ? inspect.close >= inspect.open : false

  const plotterText = (i: number): string | null => {
    if (!inspect) return null
    if (i === 0) {
      if (showHoverTip) return null
      return `O ${fmt2(inspect.open)}  H ${fmt2(inspect.high)}  L ${fmt2(inspect.low)}  C ${fmt2(inspect.close)}`
    }
    const key = HIST_KEYS[i - 1]
    if (!key || !paneOn[key]) return null
    if (key === 'vol') return `Vol ${fmtPlot(inspect.volume)}`
    if (key === 'delta') return `Δ ${fmtPlot(inspect.delta)}`
    if (key === 'dp') return `Δ% ${fmt2(inspect.delta_pct)}`
    if (key === 'cvd') return inspect.cvd != null ? `CVD ${fmtPlot(inspect.cvd)}` : 'CVD —'
    if (key === 'min') return inspect.minD != null ? `MinΔ ${fmtPlot(inspect.minD)}` : 'MinΔ —'
    if (key === 'max') return inspect.maxD != null ? `MaxΔ ${fmtPlot(inspect.maxD)}` : 'MaxΔ —'
    if (key === 'ch') return inspect.ch != null ? `CH ${fmtPlot(inspect.ch)}` : 'CH —'
    if (key === 'cl') return inspect.cl != null ? `CL ${fmtPlot(inspect.cl)}` : 'CL —'
    return null
  }

  return (
    <div className="panel chart-panel of-chart" style={{ display: visible ? undefined : 'none' }}>
      <div
        className={`of-rail right${rightOpen ? ' open' : ''}${rightPinned ? ' pinned' : ''}`}
        onMouseEnter={() => setRightOpen(true)}
        onMouseLeave={() => {
          if (!rightPinned) setRightOpen(false)
        }}
      >
      <button
        type="button"
        className={`of-edge right${rightOpen ? ' on' : ''}`}
        title={rightOpen ? 'Hide studies' : 'Show studies'}
        onClick={() => setRightOpen((v) => !v)}
      >
        STUDIES
      </button>
      <aside className={`of-drawer right${rightOpen ? ' open' : ''}`}>
        <div className="of-drawer-head">
          <b>Studies</b>
          <button
            type="button"
            className={`ghost of-pin${rightPinned ? ' on' : ''}`}
            title={rightPinned ? 'Unpin (auto-hide)' : 'Pin open'}
            onClick={() => setRightPinned((v) => !v)}
          >
            {rightPinned ? '📌' : '📍'}
          </button>
        </div>
        <span className="of-drawer-lab">Price</span>
        <div className="unit-toggle">
          {(['candle', 'bar', 'line'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={priceKind === k ? 'active' : 'ghost'}
              disabled={showFootprint && k !== 'candle'}
              onClick={() => setPriceKind(k)}
            >
              {k === 'candle' ? 'Candle' : k === 'bar' ? 'Bar' : 'Line'}
            </button>
          ))}
        </div>
        <div className="unit-toggle">
          <button type="button" className={unit === 'quote' ? 'active' : 'ghost'} onClick={() => setUnit('quote')}>
            USDT
          </button>
          <button type="button" className={unit === 'base' ? 'active' : 'ghost'} onClick={() => setUnit('base')}>
            BASE
          </button>
        </div>
        <span className="of-drawer-lab">Overlays</span>
        {(
          [
            ['Footprint', showFootprint, setShowFootprint],
            ['VAZ', showVaz, setShowVaz],
            ['COT', showCot, setShowCot],
            ['Min/Max Δ', showMinMax, setShowMinMax],
            ['VWAP', showVwap, setShowVwap],
            ['Legend', showLegend, setShowLegend],
            ['Tip', showHoverTip, setShowHoverTip],
          ] as const
        ).map(([lab, on, set]) => (
          <label key={lab} className={`ov-toggle ${on ? 'on' : ''}`}>
            <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
            {lab}
          </label>
        ))}
        <span className="of-drawer-lab">Footprint mode</span>
        <div className="unit-toggle wrap">
          {(['profile', 'bidask', 'delta', 'volume'] as const).map((m) => (
            <button key={m} type="button" className={fpMode === m ? 'active' : 'ghost'} onClick={() => setFpMode(m)}>
              {m === 'bidask' ? 'BidAsk' : m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <label>
          Bin ×
          <input
            type="number"
            min={1}
            max={10000}
            value={fpBinMult}
            onChange={(e) => setFpBinMult(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <span className="vwap-settings-hint">
          Bin = {fmtTick(symbolTickSize(symbol))} × {binSafe} = {fmtTick(symbolTickSize(symbol) * binSafe)} · {unitLabel}
        </span>
        <span className="of-drawer-lab">Sub panes</span>
        {HIST_KEYS.map((key) => (
          <label key={key} className={`ov-toggle ${paneOn[key] ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={paneOn[key]}
              onChange={(e) => setPaneOn((p) => ({ ...p, [key]: e.target.checked }))}
            />
            {HIST_LABEL[key]}
          </label>
        ))}
        {showLegend && (
          <p className="hint">
            CH/CL = this candle Δ since last new high/low. Min/Max Δ = running-delta extremes. CVD resets 05:30 IST.
          </p>
        )}
      </aside>
      </div>

      <div className="chart-wrap" ref={wrapRef}>
        {showHoverTip && inspect && (
          <div className={`of-inspector ${bull ? 'up' : 'dn'}`}>
            <div className="tt-time">{inspect.time.replace('T', ' ').slice(0, 19)} IST</div>
            <div className="tt-ohlc">
              O {fmt2(inspect.open)} H {fmt2(inspect.high)} L {fmt2(inspect.low)} C {fmt2(inspect.close)}
            </div>
            <div className="tt-flow">
              <span>
                Vol <b>{fmtPlot(inspect.volume)}</b>
              </span>
              <span>
                Δ <b className={clsSigned(inspect.delta)}>{fmtPlot(inspect.delta)}</b>
              </span>
              <span>
                Δ% <b className={clsSigned(inspect.delta_pct)}>{fmt2(inspect.delta_pct)}</b>
              </span>
              {inspect.cvd != null && (
                <span>
                  CVD <b className={clsSigned(inspect.cvd)}>{fmtPlot(inspect.cvd)}</b>
                </span>
              )}
            </div>
            {(inspect.ch != null || inspect.cl != null || inspect.minD != null || inspect.maxD != null) && (
              <div className="tt-flow">
                {inspect.maxD != null && (
                  <span>
                    MaxΔ <b className={clsSigned(inspect.maxD)}>{fmtPlot(inspect.maxD)}</b>
                  </span>
                )}
                {inspect.minD != null && (
                  <span>
                    MinΔ <b className={clsSigned(inspect.minD)}>{fmtPlot(inspect.minD)}</b>
                  </span>
                )}
                {inspect.ch != null && (
                  <span>
                    CH <b className={clsSigned(inspect.ch)}>{fmtPlot(inspect.ch)}</b>
                  </span>
                )}
                {inspect.cl != null && (
                  <span>
                    CL <b className={clsSigned(inspect.cl)}>{fmtPlot(inspect.cl)}</b>
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        <div className="chart-host" ref={hostRef} />
        <FootprintOverlay
          chartRef={chartRef}
          seriesRef={seriesRef}
          wrapRef={wrapRef}
          chartEpoch={chartEpoch}
          show={showFootprint}
          showVaz={showVaz}
          showCot={showCot}
          showMinMax={showMinMax}
          symbol={symbol}
          tf={tf}
          unit={unit}
          mode={fpMode}
          binMult={binSafe}
          barTimes={barTimes}
        />
        {paneLayouts.map((pl, i) =>
          pl.height < 20 ? null : (
            <div key={pl.id} className="pane-chrome" style={{ top: pl.top + 4, height: Math.max(0, pl.height - 8) }}>
              <span className="pane-chrome-lbl">{paneNames[i] ?? `P${i + 1}`}</span>
              <div className="pane-chrome-btns">
                <button
                  type="button"
                  className={`pane-btn${pl.state === 'minimized' ? ' on' : ''}`}
                  title={pl.state === 'minimized' ? 'Restore pane' : 'Minimize pane'}
                  onClick={() => setPaneState(pl.id, 'minimized')}
                >
                  ▬
                </button>
                <button
                  type="button"
                  className={`pane-btn${i === 0 ? (priceOnly ? ' on' : '') : pl.state === 'maximized' ? ' on' : ''}`}
                  title={i === 0 ? (priceOnly ? 'Show sub panes' : 'Price only') : 'Maximize pane'}
                  onClick={() => setPaneState(pl.id, 'maximized')}
                >
                  {pl.state === 'maximized' ? '❐' : '⛶'}
                </button>
              </div>
            </div>
          ),
        )}
        {paneLayouts.map((pl, i) => {
          const txt = plotterText(i)
          if (!txt || pl.height < 20) return null
          return (
            <div key={`pl${pl.id}`} className="of-plotter" style={{ top: pl.top + 6 }}>
              {txt}
            </div>
          )
        })}
        <div className="chart-nav" ref={navRef}>
          <button type="button" className="nav-btn" title="Zoom in" onClick={() => zoom(0.7)}>
            +
          </button>
          <button type="button" className="nav-btn" title="Zoom out" onClick={() => zoom(1.4)}>
            −
          </button>
          <button type="button" className="nav-btn" title="Reset zoom (fit all)" onClick={reset}>
            ↺
          </button>
          <button type="button" className="nav-btn" title="Reset price scale (Y only)" onClick={resetY}>
            Y
          </button>
          <button type="button" className="nav-btn" title="End / last candle" onClick={end}>
            ⇥
          </button>
          <button type="button" className="nav-btn" title="Offset candles to the right" onClick={offsetRight}>
            →|
          </button>
        </div>
      </div>
    </div>
  )
}
