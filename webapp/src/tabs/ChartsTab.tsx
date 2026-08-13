import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPaneApi,
  type LineStyleValue,
} from '@stocksharp/chart'
import type { BacktestResult, BarRow } from '../api'
import { fmt2 } from '../format'
import { loadChartRange, saveChartRange } from '../chartZoomStore'
import { attachCandlePricePan, resetPriceOnly } from '../chartPricePan'
import { attachMarkerLabels, type MarkerLabel } from '../chartMarkerLabels'
import { selectTrade, useChartStudy } from '../chartStudyStore'
import {
  classifyAggrTag,
  computeVwap,
  outsideVwapNSigma,
  parseBandMultipliers,
  type AggrTag,
  type VwapSession,
  type VwapSettings,
  type VwapSource,
} from '../computeVwap'

const AGGR_TAG_COLOR: Record<AggrTag, string> = {
  Lo: '#3fb950',
  Sh: '#f85149',
  Se: '#ff7b72',
  Co: '#58a6ff',
}

type Unit = 'quote' | 'base'

type Props = {
  data: BacktestResult | null
  /** When false, keep chart mounted but hidden (preserves zoom). */
  visible?: boolean
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
  vwap?: number
  vwapBands?: { mult: number; up: number; dn: number }[]
}

const VWAP_COLOR = '#26a69a'
const VWAP_BAND_COLORS = ['#26a69a99', '#26a69a66', '#26a69a44']

type PaneLayout = { top: number; height: number; id: string; state: string }

function volOf(b: BarRow, unit: Unit) {
  if (unit === 'base') return Number(b.volume_base ?? 0)
  return Number(b.volume_quote ?? b.volume ?? 0)
}

function deltaOf(b: BarRow, unit: Unit) {
  if (unit === 'base') return Number(b.delta_base ?? 0)
  return Number(b.delta_quote ?? b.delta ?? 0)
}

function clsSigned(n: number) {
  if (n > 0) return 'pos'
  if (n < 0) return 'neg'
  return ''
}

/** Snap a unix-second timestamp onto the bar open that contains it. */
function snapToBarTime(tsSec: number, barTimes: number[], tfSec: number): number {
  if (!barTimes.length) return tsSec
  let lo = 0
  let hi = barTimes.length - 1
  let best = barTimes[0]
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const t = barTimes[mid]
    if (t <= tsSec) {
      best = t
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (tsSec >= best && tsSec < best + tfSec) return best
  if (tsSec < barTimes[0]) return barTimes[0]
  return best
}

export function ChartsTab({ data, visible = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const panesRef = useRef<IPaneApi[]>([])
  const [unit, setUnit] = useState<Unit>('quote')
  const [tip, setTip] = useState<Tip | null>(null)
  const [showSignals, setShowSignals] = useState(true)
  const [showTrades, setShowTrades] = useState(true)
  const [showVwap, setShowVwap] = useState(false)
  const [vwapSource, setVwapSource] = useState<VwapSource>('hlc3')
  const [vwapSession, setVwapSession] = useState<VwapSession>('binance')
  const [vwapBandsRaw, setVwapBandsRaw] = useState('1,2')
  const [showVwapSettings, setShowVwapSettings] = useState(false)
  const [paneLayouts, setPaneLayouts] = useState<PaneLayout[]>([])
  const [panelMax, setPanelMax] = useState(false)
  const dataKey = useRef<string>('')
  const study = useChartStudy()

  const unitLabel = unit === 'quote' ? 'USDT' : 'BASE'
  const vwapBands = useMemo(() => parseBandMultipliers(vwapBandsRaw), [vwapBandsRaw])
  const vwapSettings: VwapSettings = useMemo(
    () => ({
      source: vwapSource,
      session: vwapSession,
      bands: vwapBands.length ? vwapBands : [1, 2],
    }),
    [vwapSource, vwapSession, vwapBands],
  )
  const vwapSeries = useMemo(() => {
    if (!data || !showVwap) return []
    return computeVwap(data.bars, unit, vwapSettings)
  }, [data, showVwap, unit, vwapSettings])
  const vwapByTime = useMemo(() => {
    const m = new Map<number, (typeof vwapSeries)[number]>()
    for (const p of vwapSeries) m.set(p.time, p)
    return m
  }, [vwapSeries])

  const byTime = useMemo(() => {
    const m = new Map<number, BarRow>()
    data?.bars.forEach((b) => m.set(b.time, b))
    return m
  }, [data])

  const barTimes = useMemo(() => (data ? data.bars.map((b) => b.time) : []), [data])

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
          return {
            id: p.id(),
            top: size.top,
            height: size.height,
            state: p.options().state,
          }
        }),
      )
      const nav = navRef.current
      const main = panes[0]?.getSize()
      if (nav && main && main.height > 40) {
        nav.style.top = `${main.top + main.height - 44}px`
        nav.style.bottom = 'auto'
        nav.style.display = ''
      } else if (nav) {
        nav.style.display = 'none'
      }
    } catch {
      /* ignore */
    }
  }

  // Rebuild chart when data / unit / overlays change (not on trade selection).
  useEffect(() => {
    const el = hostRef.current
    if (!el || !data) return

    const key = [
      data.symbol,
      data.tf_minutes,
      data.bars.length,
      data.trades.length,
      unit,
      showSignals,
      showTrades,
      showVwap,
      vwapSettings.source,
      vwapSettings.session,
      vwapSettings.bands.join(','),
    ].join('|')
    el.innerHTML = ''
    const chart = createChart(el, {
      layout: {
        background: { type: 'solid', color: '#0f1419' },
        textColor: '#8b949e',
      },
      grid: {
        vertLines: { color: '#21262d' },
        horzLines: { color: '#21262d' },
      },
      rightPriceScale: { borderColor: '#30363d' },
      timeScale: {
        borderColor: '#30363d',
        timeVisible: true,
        timeZone: 'Asia/Kolkata',
        locale: 'en-IN',
      },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
      },
    })
    chartRef.current = chart
    dataKey.current = key

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#3fb950',
      downColor: '#f85149',
      borderVisible: false,
      wickUpColor: '#3fb950',
      wickDownColor: '#f85149',
    })
    candles.setData(
      data.bars.map((b) => ({
        time: b.time as never,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    )

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
        up.setData(
          vwapSeries.map((p) => ({
            time: p.time as never,
            value: p.bands[`up${mult}`],
          })),
        )
        dn.setData(
          vwapSeries.map((p) => ({
            time: p.time as never,
            value: p.bands[`dn${mult}`],
          })),
        )
      })
    }

    const tfSec = Math.max(1, data.tf_minutes) * 60
    const lots = Number(data.volume)
    const lotsLbl = fmt2(lots)
    const snap = (iso: string) =>
      snapToBarTime(Math.floor(new Date(iso).getTime() / 1000), barTimes, tfSec)

    const addRay = (
      t0: number,
      t1: number,
      price: number,
      color: string,
      style: LineStyleValue,
      width: 1 | 2 | 3 | 4,
      title: string,
      axis = true,
    ) => {
      const seg = chart.addSeries(LineSeries, {
        color,
        lineWidth: width,
        lineStyle: style,
        lastValueVisible: false,
        priceLineVisible: false,
      })
      seg.setData([
        { time: t0 as never, value: price },
        { time: t1 as never, value: price },
      ])
      if (axis) {
        candles.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: style,
          lineVisible: false,
          axisLabelVisible: true,
          title,
        })
      }
    }

    if (showTrades) {
      data.trades.forEach((tr) => {
        const short = tr.side === 'Short'
        let t0 = snap(tr.entry_time)
        let t1 = snap(tr.exit_time)
        if (t1 < t0) t1 = t0
        if (t1 === t0) t1 = t0 + tfSec
        t1 = snapToBarTime(t1, barTimes, tfSec)
        if (t1 <= t0) {
          const idx = barTimes.indexOf(t0)
          t1 = idx >= 0 && idx + 1 < barTimes.length ? barTimes[idx + 1] : t0 + tfSec
        }

        const tagIn = (tr.entry_tag || (short ? 'SE' : 'LE')).toUpperCase()
        const tagTp = short ? 'ST' : 'LT'
        const tagSl = short ? 'SSL' : 'LSL'
        const beLocked = Boolean(tr.be_moved)
        const stopColor = beLocked ? '#f0b429' : '#f85149'
        const stopTitle = beLocked
          ? `BE ${tagSl} @ ${fmt2(tr.stop)}`
          : `${tagSl} @ ${fmt2(tr.stop)}`

        addRay(t0, t1, tr.entry_price, '#f0b429', LineStyle.Solid, 2, `${tagIn} @ ${fmt2(tr.entry_price)}`)
        addRay(t0, t1, tr.target, '#3fb950', LineStyle.Dashed, 1, `${tagTp} @ ${fmt2(tr.target)}`)
        addRay(t0, t1, tr.stop, stopColor, LineStyle.Dashed, beLocked ? 2 : 1, stopTitle)

        const exitPin = chart.addSeries(LineSeries, {
          color: '#a371f7',
          lineWidth: 2,
          lastValueVisible: false,
          priceLineVisible: false,
        })
        exitPin.setData([{ time: t1 as never, value: tr.exit_price }])
      })
    }

    const markers: Array<{
      time: never
      position: 'aboveBar' | 'belowBar'
      color: string
      shape: 'arrowDown' | 'arrowUp' | 'circle'
      text?: string
    }> = []
    const tradeLabels: MarkerLabel[] = []

    if (showSignals) {
      const thr = Number(data.threshold) || 50
      const sigmaN = Number(
        (data.params as { pro_vwap_sigma?: number } | undefined)?.pro_vwap_sigma ??
          (data.stats as { pro_vwap_sigma?: number } | undefined)?.pro_vwap_sigma ??
          2,
      )
      const vwapPts = computeVwap(data.bars, unit, {
        source: 'hlc3',
        session: 'binance',
        bands: [sigmaN],
      })
      const vwapMap = new Map(vwapPts.map((p) => [p.time, p]))
      for (const a of data.aggressive) {
        const t = snap(a.time)
        const idx = barTimes.indexOf(t)
        const ltp = idx > 0 ? Number(data.bars[idx - 1]?.close) : Number(a.open)
        const backendTag = (a.pro_tag || '') as AggrTag | ''
        const vp = vwapMap.get(t)
        const vwapOk =
          a.vwap_ok === true ||
          (vp
            ? outsideVwapNSigma(Number(a.high), Number(a.low), vp.vwap, vp.stdev, sigmaN)
            : false)
        const tag =
          backendTag === 'Lo' ||
          backendTag === 'Sh' ||
          backendTag === 'Se' ||
          backendTag === 'Co'
            ? backendTag
            : vwapOk
              ? classifyAggrTag(Number(a.delta_pct), thr, Number(a.high), Number(a.low), ltp)
              : null
        const sell = a.side === 'Sell'
        const color = tag ? AGGR_TAG_COLOR[tag] : sell ? '#f85149' : '#58a6ff'
        const longBias = tag === 'Lo' || tag === 'Co'
        markers.push({
          time: t as never,
          position: longBias || (!tag && !sell) ? 'belowBar' : 'aboveBar',
          color,
          shape: 'circle',
          text: tag || undefined,
        })
        if (tag) {
          tradeLabels.push({
            time: t,
            price: sell ? Number(a.high) : Number(a.low),
            position: longBias ? 'belowBar' : 'aboveBar',
            color,
            line1: tag,
            line2: `Δ% ${fmt2(a.delta_pct)}`,
          })
        }
      }
    }

    if (showTrades) {
      for (const tr of data.trades) {
        const short = tr.side === 'Short'
        const tagIn = (tr.entry_tag || (short ? 'SE' : 'LE')).toUpperCase()
        const rev = tagIn === 'LR' || tagIn === 'SR'
        const entryColor = rev ? '#d2a8ff' : short ? '#f85149' : '#3fb950'
        const entryPos: 'aboveBar' | 'belowBar' = short ? 'aboveBar' : 'belowBar'
        const tEntry = snap(tr.entry_time)
        // Triangles for entries (distinct from AGGR circles)
        markers.push({
          time: tEntry as never,
          position: entryPos,
          color: entryColor,
          shape: short ? 'arrowDown' : 'arrowUp',
        })
        tradeLabels.push({
          time: tEntry,
          price: tr.entry_price,
          position: entryPos,
          color: entryColor,
          line1: tagIn,
          line2: `${fmt2(tr.entry_price)} - ${lotsLbl}`,
        })

        const reason = (tr.exit_reason || '').toUpperCase()
        const exitRev = reason === 'LR' || reason === 'SR'
        const hitBe = reason === 'LB' || reason === 'SB'
        const hitStop = reason === 'LSL' || reason === 'SSL' || hitBe
        const hitTarget = reason === 'LT' || reason === 'ST'
        let exitPos: 'aboveBar' | 'belowBar' = short ? 'belowBar' : 'aboveBar'
        if (hitStop) exitPos = short ? 'aboveBar' : 'belowBar'
        else if (hitTarget) exitPos = short ? 'belowBar' : 'aboveBar'
        const exitColor = exitRev
          ? '#d2a8ff'
          : hitBe
            ? '#f0b429'
            : reason === 'LSL' || reason === 'SSL'
              ? '#f85149'
              : '#a371f7'
        const tExit = snap(tr.exit_time)
        markers.push({
          time: tExit as never,
          position: exitPos,
          color: exitColor,
          shape: 'circle',
        })
        tradeLabels.push({
          time: tExit,
          price: tr.exit_price,
          position: exitPos,
          color: exitColor,
          line1: String(tr.exit_reason || ''),
          line2: `${fmt2(tr.exit_price)} - ${lotsLbl}`,
        })
      }
    }

    markers.sort((a, b) => Number(a.time) - Number(b.time))
    if (markers.length) createSeriesMarkers(candles, markers)
    const detachLabels = attachMarkerLabels(el, chart, candles, tradeLabels)

    const volPane = chart.addPane({ height: 90, minHeight: 28 })
    const vol = volPane.addSeries(HistogramSeries, {
      color: '#484f58',
      priceFormat: { type: 'volume' },
    })
    vol.setData(
      data.bars.map((b) => ({
        time: b.time as never,
        value: volOf(b, unit),
        color: b.close >= b.open ? '#3fb95088' : '#f8514988',
      })),
    )

    const dPane = chart.addPane({ height: 90, minHeight: 28 })
    const delta = dPane.addSeries(HistogramSeries, { color: '#3fb950' })
    delta.setData(
      data.bars.map((b) => {
        const v = deltaOf(b, unit)
        return {
          time: b.time as never,
          value: v,
          color: v >= 0 ? '#3fb950' : '#f85149',
        }
      }),
    )

    const dpPane = chart.addPane({ height: 90, minHeight: 28 })
    const dp = dpPane.addSeries(HistogramSeries, { color: '#58a6ff' })
    dp.setData(
      data.bars.map((b) => ({
        time: b.time as never,
        value: b.delta_pct,
        color: b.delta_pct >= 0 ? '#3fb950' : '#f85149',
      })),
    )
    const thr = data.threshold || 50
    const up = dpPane.addSeries(LineSeries, { color: '#f0b429', lineWidth: 1 })
    const dn = dpPane.addSeries(LineSeries, { color: '#f0b429', lineWidth: 1 })
    up.setData(data.bars.map((b) => ({ time: b.time as never, value: thr })))
    dn.setData(data.bars.map((b) => ({ time: b.time as never, value: -thr })))

    // Ensure main price pane has a sensible default height + min.
    try {
      const main = chart.panes()[0]
      main?.applyOptions({ minHeight: 80, height: Math.max(220, main.options().height || 280) })
    } catch {
      /* ignore */
    }

    const onMove = (param: {
      time?: unknown
      point?: { x: number; y: number } | undefined
    }) => {
      if (!param.time || param.point === undefined) {
        setTip(null)
        return
      }
      const t = Number(param.time)
      const b = byTime.get(t)
      if (!b) {
        setTip(null)
        return
      }
      const vp = showVwap ? vwapByTime.get(t) : undefined
      setTip({
        time: b.time_iso,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: volOf(b, unit),
        delta: deltaOf(b, unit),
        delta_pct: b.delta_pct,
        vwap: vp?.vwap,
        vwapBands: vp
          ? vwapSettings.bands.map((mult) => ({
              mult,
              up: vp.bands[`up${mult}`],
              dn: vp.bands[`dn${mult}`],
            }))
          : undefined,
      })
    }
    chart.subscribeCrosshairMove(onMove as never)

    const onRange = () => {
      const r = chart.timeScale().getVisibleLogicalRange()
      if (r) saveChartRange({ from: r.from, to: r.to })
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    const saved = loadChartRange()
    if (saved) {
      try {
        chart.timeScale().setVisibleLogicalRange(saved)
      } catch {
        chart.timeScale().fitContent()
      }
    } else {
      chart.timeScale().fitContent()
    }

    const onResize = () => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
      chart.resize(el.clientWidth, el.clientHeight)
      requestAnimationFrame(syncPaneOverlays)
    }
    onResize()
    window.addEventListener('resize', onResize)
    const detachPricePan = attachCandlePricePan(chart, el)
    requestAnimationFrame(syncPaneOverlays)

    return () => {
      const r = chart.timeScale().getVisibleLogicalRange()
      if (r) saveChartRange({ from: r.from, to: r.to })
      detachLabels()
      detachPricePan()
      window.removeEventListener('resize', onResize)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      chart.unsubscribeCrosshairMove(onMove as never)
      chart.remove()
      chartRef.current = null
      panesRef.current = []
      setPaneLayouts([])
    }
  }, [
    data,
    unit,
    byTime,
    barTimes,
    showSignals,
    showTrades,
    showVwap,
    vwapSeries,
    vwapByTime,
    vwapSettings,
  ])

  // Camera: jump to selected trade without rebuilding the chart.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !data || study.selectedTrade === null) return
    const tr = data.trades[study.selectedTrade]
    if (!tr) return
    const tfSec = Math.max(1, data.tf_minutes) * 60
    const snap = (iso: string) =>
      snapToBarTime(Math.floor(new Date(iso).getTime() / 1000), barTimes, tfSec)
    const t0 = snap(tr.entry_time)
    const t1 = snap(tr.exit_time)
    const i0 = Math.max(0, barTimes.indexOf(t0) - 4)
    const i1 = Math.min(barTimes.length - 1, Math.max(barTimes.indexOf(t1), i0) + 6)
    try {
      chart.timeScale().setVisibleLogicalRange({ from: i0, to: i1 })
      saveChartRange({ from: i0, to: i1 })
    } catch {
      /* ignore */
    }
  }, [study.selectedTrade, data, barTimes])

  useEffect(() => {
    if (!visible) return
    const chart = chartRef.current
    const el = hostRef.current
    if (!chart || !el) return
    const restore = () => {
      if (el.clientWidth < 2 || el.clientHeight < 2) return
      chart.resize(el.clientWidth, el.clientHeight)
      const saved = loadChartRange()
      if (saved) {
        try {
          chart.timeScale().setVisibleLogicalRange(saved)
        } catch {
          /* ignore */
        }
      }
      syncPaneOverlays()
    }
    requestAnimationFrame(restore)
    const ro = new ResizeObserver(() => restore())
    ro.observe(el)
    return () => ro.disconnect()
  }, [visible, panelMax])

  const zoom = (factor: number) => {
    const chart = chartRef.current
    if (!chart) return
    const ts = chart.timeScale()
    const range = ts.getVisibleLogicalRange()
    if (!range) return
    const mid = (range.from + range.to) / 2
    const half = ((range.to - range.from) / 2) * factor
    const next = { from: mid - half, to: mid + half }
    ts.setVisibleLogicalRange(next)
    saveChartRange(next)
  }

  const reset = () => {
    chartRef.current?.timeScale().fitContent()
    const r = chartRef.current?.timeScale().getVisibleLogicalRange()
    if (r) saveChartRange({ from: r.from, to: r.to })
  }
  const resetY = () => {
    const chart = chartRef.current
    if (!chart) return
    resetPriceOnly(chart)
  }
  const end = () => {
    chartRef.current?.timeScale().scrollToRealTime()
    const r = chartRef.current?.timeScale().getVisibleLogicalRange()
    if (r) saveChartRange({ from: r.from, to: r.to })
  }

  const setPaneState = (paneId: string, state: 'normal' | 'minimized' | 'maximized') => {
    const pane = panesRef.current.find((p) => p.id() === paneId)
    if (!pane) return
    // Toggle off if already in that state
    const cur = pane.options().state
    const next = cur === state ? 'normal' : state
    try {
      if (next === 'maximized') {
        for (const p of panesRef.current) {
          if (p.id() !== paneId && p.options().state === 'maximized') {
            p.applyOptions({ state: 'normal' })
          }
        }
      }
      pane.applyOptions({ state: next })
      requestAnimationFrame(syncPaneOverlays)
    } catch {
      /* ignore */
    }
  }

  if (!data) {
    return (
      <p className="hint">
        Idle — click <b>Run backtest</b> to visualize.
      </p>
    )
  }

  const bull = tip ? tip.close >= tip.open : false
  const sel = study.selectedTrade
  const paneNames = ['Price', 'Vol', 'Δ', 'Δ%']

  return (
    <div
      className={`panel chart-panel${panelMax ? ' panel-maximized' : ''}`}
      style={{ display: visible ? 'flex' : 'none' }}
    >
      <div className="chart-toolbar tight-toolbar">
        <div className="unit-toggle" role="group" aria-label="Volume unit">
          <button
            type="button"
            className={unit === 'quote' ? 'active' : 'ghost'}
            onClick={() => setUnit('quote')}
          >
            USDT
          </button>
          <button
            type="button"
            className={unit === 'base' ? 'active' : 'ghost'}
            onClick={() => setUnit('base')}
          >
            BASE
          </button>
        </div>

        <div className="overlay-toggles" role="group" aria-label="Chart overlays">
          <label className={`ov-toggle ${showSignals ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={showSignals}
              onChange={(e) => setShowSignals(e.target.checked)}
            />
            Signals
          </label>
          <label className={`ov-toggle ${showTrades ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={showTrades}
              onChange={(e) => setShowTrades(e.target.checked)}
            />
            Trades
          </label>
          <label className={`ov-toggle ${showVwap ? 'on' : ''}`} title="Session VWAP ± std-dev bands">
            <input
              type="checkbox"
              checked={showVwap}
              onChange={(e) => {
                const on = e.target.checked
                setShowVwap(on)
                if (on) setShowVwapSettings(true)
              }}
            />
            VWAP
          </label>
          {showVwap && (
            <button
              type="button"
              className={`ghost ov-settings-btn ${showVwapSettings ? 'on' : ''}`}
              title="VWAP settings"
              onClick={() => setShowVwapSettings((v) => !v)}
            >
              ⚙
            </button>
          )}
        </div>

        {sel !== null && (
          <button type="button" className="ghost" onClick={() => selectTrade(null)} title="Clear trade selection">
            Trade #{sel + 1} ✕
          </button>
        )}

        <div className="legend-row" style={{ margin: 0, flex: 1 }}>
          <span className="lg">
            <i style={{ background: '#3fb950' }} /> Price
          </span>
          <span className="lg">
            <i style={{ background: '#8b949e' }} /> Vol ({unitLabel})
          </span>
          <span className="lg">
            <i style={{ background: '#3fb950' }} /> Δ ({unitLabel})
          </span>
          <span className="lg">
            <i style={{ background: '#58a6ff' }} /> Δ%
          </span>
          {showTrades && (
            <>
              <span className="lg" title="Long entry">
                <i className="lg-tri-up" style={{ borderBottomColor: '#3fb950' }} /> Long
              </span>
              <span className="lg" title="Short entry">
                <i className="lg-tri-dn" style={{ borderTopColor: '#f85149' }} /> Short
              </span>
              <span className="lg">
                <i style={{ background: '#f0b429' }} /> Entry ray
              </span>
              <span className="lg">
                <i style={{ background: '#3fb950' }} /> Target
              </span>
              <span className="lg">
                <i style={{ background: '#f85149' }} /> Stop
              </span>
            </>
          )}
          {showSignals && (
            <>
              <span className="lg" title="Long Buy — +Δ% & high ≥ LTP">
                <i style={{ background: AGGR_TAG_COLOR.Lo, borderRadius: '50%' }} /> Lo
              </span>
              <span className="lg" title="Short Sell — −Δ% & low ≤ LTP">
                <i style={{ background: AGGR_TAG_COLOR.Sh, borderRadius: '50%' }} /> Sh
              </span>
              <span className="lg" title="Long liquidation Sell — +Δ% & low ≤ LTP (bar below LTP)">
                <i style={{ background: AGGR_TAG_COLOR.Se, borderRadius: '50%' }} /> Se
              </span>
              <span className="lg" title="Short covering Buy — −Δ% & high ≥ LTP (bar above LTP)">
                <i style={{ background: AGGR_TAG_COLOR.Co, borderRadius: '50%' }} /> Co
              </span>
            </>
          )}
          {showVwap && (
            <>
              <span className="lg">
                <i style={{ background: VWAP_COLOR }} /> VWAP
              </span>
              {vwapSettings.bands.map((m, i) => (
                <span className="lg" key={m}>
                  <i
                    style={{
                      background: VWAP_BAND_COLORS[Math.min(i, VWAP_BAND_COLORS.length - 1)],
                    }}
                  />{' '}
                  ±{m}σ
                </span>
              ))}
            </>
          )}
        </div>

        <button
          type="button"
          className="ghost panel-max-btn"
          title={panelMax ? 'Restore chart panel' : 'Maximize chart panel'}
          onClick={() => setPanelMax((v) => !v)}
        >
          {panelMax ? '❐' : '⛶'}
        </button>
      </div>

      {showVwap && showVwapSettings && (
        <div className="vwap-settings" role="group" aria-label="VWAP settings">
          <label>
            Source
            <select
              value={vwapSource}
              onChange={(e) => setVwapSource(e.target.value as VwapSource)}
            >
              <option value="hlc3">HLC/3</option>
              <option value="ohlc4">OHLC/4</option>
              <option value="hl2">HL/2</option>
              <option value="close">Close</option>
            </select>
          </label>
          <label title="Binance UM session VWAP resets at 05:30 IST (00:00 UTC), not midnight IST">
            Session
            <select
              value={vwapSession}
              onChange={(e) => setVwapSession(e.target.value as VwapSession)}
            >
              <option value="binance">Binance 05:30 IST</option>
              <option value="range">Entire range</option>
            </select>
          </label>
          <label title="Comma-separated std-dev multipliers, e.g. 1,2 or 0.5,1,2">
            Bands σ
            <input
              value={vwapBandsRaw}
              onChange={(e) => setVwapBandsRaw(e.target.value)}
              placeholder="1,2"
            />
          </label>
          <span className="vwap-settings-hint">
            Vol unit follows {unitLabel} · works on any TF (e.g. 15m)
          </span>
        </div>
      )}

      <div className="chart-wrap" ref={wrapRef}>
        {tip && (
          <div className="chart-tooltip">
            <div className="tt-time">{tip.time.replace('T', ' ').slice(0, 19)}</div>
            <div className="tt-ohlc">
              <span>
                O <b className={bull ? 'pos' : 'neg'}>{fmt2(tip.open)}</b>
              </span>
              <span>
                H <b className="pos">{fmt2(tip.high)}</b>
              </span>
              <span>
                L <b className="neg">{fmt2(tip.low)}</b>
              </span>
              <span>
                C <b className={bull ? 'pos' : 'neg'}>{fmt2(tip.close)}</b>
              </span>
            </div>
            <div className="tt-flow">
              <span>
                Vol <b>{fmt2(tip.volume)}</b>
              </span>
              <span>
                Δ <b className={clsSigned(tip.delta)}>{fmt2(tip.delta)}</b>
              </span>
              <span>
                Δ% <b className={clsSigned(tip.delta_pct)}>{fmt2(tip.delta_pct)}</b>
              </span>
            </div>
            {tip.vwap != null && (
              <div className="tt-flow tt-vwap">
                <span>
                  VWAP <b>{fmt2(tip.vwap)}</b>
                </span>
                {tip.vwapBands?.map((b) => (
                  <span key={b.mult}>
                    ±{b.mult}σ <b>{fmt2(b.dn)}</b>–<b>{fmt2(b.up)}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="chart-host" ref={hostRef} />
        {paneLayouts.map((pl, i) =>
          pl.height < 20 ? null : (
            <div
              key={pl.id}
              className="pane-chrome"
              style={{ top: pl.top + 4, height: Math.max(0, pl.height - 8) }}
            >
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
                  className={`pane-btn${pl.state === 'maximized' ? ' on' : ''}`}
                  title={pl.state === 'maximized' ? 'Restore pane' : 'Maximize pane'}
                  onClick={() => setPaneState(pl.id, 'maximized')}
                >
                  {pl.state === 'maximized' ? '❐' : '⛶'}
                </button>
              </div>
            </div>
          ),
        )}
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
          <button type="button" className="nav-btn" title="End / latest" onClick={end}>
            ⇥
          </button>
        </div>
      </div>
    </div>
  )
}
