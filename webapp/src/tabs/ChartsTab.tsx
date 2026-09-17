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
import type { BacktestResult, BarRow, StrategyParams, TradeRow } from '../api'
import { fmt2 } from '../format'
import { loadChartRange, saveChartRange } from '../chartZoomStore'
import { loadChartUi, saveChartUi } from '../userSettingsStore'
import { attachCandlePricePan, resetPriceOnly } from '../chartPricePan'
import { attachMarkerLabels, type MarkerLabel } from '../chartMarkerLabels'
import { FootprintOverlay, type CandleSeries, type FootprintMode } from '../FootprintOverlay'
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

const TRAIL_CYAN = '#22d3ee'
const BE_WHITE = '#ffffff'
const TRAIL_DOTTED: LineStyleValue =
  ((LineStyle as unknown as { Dotted?: LineStyleValue }).Dotted ?? LineStyle.Dashed)

/** Horizontal-then-vertical vertices so trail plots as a staircase (unique times). */
function staircaseFromStops(pts: { time: number; value: number }[]) {
  const uniq: { time: number; value: number }[] = []
  for (const p of pts) {
    const t = Math.floor(p.time)
    if (!Number.isFinite(t) || !Number.isFinite(p.value)) continue
    const last = uniq[uniq.length - 1]
    if (last && last.time === t) last.value = p.value
    else uniq.push({ time: t, value: p.value })
  }
  if (uniq.length < 2) return uniq
  const out: { time: number; value: number }[] = [{ ...uniq[0] }]
  for (let i = 1; i < uniq.length; i++) {
    const prev = uniq[i - 1]
    const cur = uniq[i]
    if (cur.time > prev.time + 1) out.push({ time: cur.time - 1, value: prev.value })
    out.push({ ...cur })
  }
  return out
}

type Unit = 'quote' | 'base'

type Props = {
  data: BacktestResult | null
  /** When false, keep chart mounted but hidden (preserves zoom). */
  visible?: boolean
  /** Show Lo/Sh/Se/Co AGGR tags only in Pro strategy mode. */
  proMode?: boolean
  /** Pro-MTF: plot HTF bias invalidator levels on the LTF chart. */
  proMtfMode?: boolean
}

/** Library `size=1` is ~20px. Scale to candle width; hide AGGR when bars are too thin. */
const MARKER_GLYPH_PX = 20
const AGGR_MIN_BAR_PX = 5.5

type ChartMarker = {
  time: never
  position: 'aboveBar' | 'belowBar'
  color: string
  shape: 'arrowDown' | 'arrowUp' | 'circle'
  text?: string
  kind: 'aggr' | 'trade'
}

function markerSizeFromBarPx(barPx: number, kind: ChartMarker['kind']): number {
  const frac = kind === 'aggr' ? 0.42 : 0.62
  const targetPx = Math.min(kind === 'aggr' ? 10 : 12, Math.max(1.4, barPx * frac))
  return Math.max(0.05, Math.min(1.05, targetPx / MARKER_GLYPH_PX))
}

type TradeTip = {
  side: 'Long' | 'Short' | 'Flat'
  entry?: number
  lots?: number
  sl?: number
  tp?: number
  be?: { state: 'locked' | 'waiting'; px: number; arm?: number }
  trail?: number
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
  trade: TradeTip
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

const FAR_PX = 1e8

function isoToSec(iso: string): number {
  const n = Date.parse(iso)
  return Number.isFinite(n) ? Math.floor(n / 1000) : 0
}

function isFarPx(px: number): boolean {
  return !Number.isFinite(px) || Math.abs(px) >= FAR_PX
}

function flagOn(v: unknown): boolean {
  if (v === true) return true
  if (v === false || v == null || v === '') return false
  const n = Number(v)
  return Number.isFinite(n) && n !== 0
}

function symbolTickSize(symbol: string): number {
  return (symbol || '').toUpperCase().startsWith('BTC') ? 0.1 : 0.01
}

function fmtTick(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n.toFixed(10).replace(/\.?0+$/, '')
}

/** Trade open on this candle: entry < bar end and exit ≥ bar open. Later entry wins (reverse). */
function tradeOpenOnBar(trades: TradeRow[], barSec: number, tfSec: number): TradeRow | null {
  const barEnd = barSec + tfSec
  let best: TradeRow | null = null
  let bestEntry = -Infinity
  for (const tr of trades) {
    const e = isoToSec(tr.entry_time)
    const x = isoToSec(tr.exit_time)
    if (e < barEnd && x >= barSec && e >= bestEntry) {
      best = tr
      bestEntry = e
    }
  }
  return best
}

function trailStopAt(tr: TradeRow, barSec: number, tfSec: number): number | null {
  const cutoff = barSec + tfSec
  let last: number | null = null
  for (const p of tr.trail_path ?? []) {
    if (isoToSec(p.time) <= cutoff) last = Number(p.stop)
  }
  if (last == null || isFarPx(last)) {
    const s = Number(tr.stop_init ?? tr.stop)
    return isFarPx(s) ? null : s
  }
  return last
}

function bePrices(
  tr: TradeRow,
  params: StrategyParams | undefined,
  symbol: string,
  lots: number,
): { arm: number; lock: number } {
  const arm0 = Number(tr.be_arm)
  const lock0 = Number(tr.be_lock)
  if (Number.isFinite(arm0) && Number.isFinite(lock0) && (arm0 !== 0 || lock0 !== 0)) {
    return { arm: arm0, lock: lock0 }
  }
  const isLong = tr.side === 'Long'
  const entry = Number(tr.entry_price)
  const rng = Number(tr.range)
  const unit = params?.be_unit ?? 'range'
  const beVal = Number(params?.be_value ?? 0)
  let off = Number.isFinite(rng) ? rng : 0
  if (unit === 'tick') off = beVal * symbolTickSize(symbol)
  else if (unit === 'points') off = beVal
  const lotsN = Math.max(Math.abs(lots) || 0, 1e-12)
  const notional = Math.abs(entry) * lotsN
  const slipQ = notional * (Math.abs(Number(params?.slippage_pct ?? 0)) / 100)
  const feeQ = notional * (Math.abs(Number(params?.fee_pct ?? 0)) / 100)
  const lockOff = (slipQ + feeQ) * Math.max(Number(params?.be_ctc ?? 2), 0) / lotsN
  return {
    arm: isLong ? entry + off : entry - off,
    lock: isLong ? entry + lockOff : entry - lockOff,
  }
}

function buildTradeTip(data: BacktestResult, barSec: number): TradeTip {
  const tfSec = Math.max(1, Number(data.tf_minutes) || 1) * 60
  const tr = tradeOpenOnBar(data.trades ?? [], barSec, tfSec)
  if (!tr) return { side: 'Flat' }
  const p = data.params
  const s = data.stats as Record<string, unknown> | undefined
  const slOn = flagOn(p?.sl_on ?? s?.sl_on)
  const tpOn = flagOn(p?.tp_on ?? s?.tp_on)
  const beOn = flagOn(p?.break_even ?? s?.break_even ?? data.break_even)
  const trailOn = flagOn(p?.trail_stop ?? s?.trail_stop)
  const tip: TradeTip = {
    side: tr.side === 'Short' ? 'Short' : 'Long',
    entry: Number(tr.entry_price),
    lots: Number(tr.lots ?? data.volume),
  }
  if (slOn) {
    const sl = Number(tr.stop_init ?? tr.stop)
    if (!isFarPx(sl)) tip.sl = sl
  }
  if (tpOn) {
    const tp = Number(tr.target)
    if (!isFarPx(tp)) tip.tp = tp
  }
  if (beOn) {
    const { arm, lock } = bePrices(tr, p, data.symbol, Number(tr.lots ?? data.volume))
    const locked =
      Boolean(tr.be_moved) &&
      (tr.be_moved_time ? isoToSec(tr.be_moved_time) < barSec + tfSec : true)
    tip.be = {
      state: locked ? 'locked' : 'waiting',
      px: locked ? lock : Number(tr.entry_price),
      arm,
    }
  }
  if (trailOn) {
    const trail = trailStopAt(tr, barSec, tfSec)
    if (trail != null) tip.trail = trail
  }
  return tip
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

export function ChartsTab({ data, visible = true, proMode = false, proMtfMode = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<CandleSeries | null>(null)
  const panesRef = useRef<IPaneApi[]>([])
  const savedUi = useMemo(() => loadChartUi(), [])
  const [unit, setUnit] = useState<Unit>(savedUi.unit)
  const [tip, setTip] = useState<Tip | null>(null)
  const [showSignals, setShowSignals] = useState(savedUi.showSignals)
  const [showTrades, setShowTrades] = useState(savedUi.showTrades)
  const [showMtfLevels, setShowMtfLevels] = useState(savedUi.showMtfLevels)
  const [showVwap, setShowVwap] = useState(savedUi.showVwap)
  const [showFootprint, setShowFootprint] = useState(savedUi.showFootprint)
  const [showVaz, setShowVaz] = useState(savedUi.showVaz)
  const [showCot, setShowCot] = useState(savedUi.showCot)
  const [showMinMax, setShowMinMax] = useState(savedUi.showMinMax)
  const [showLegend, setShowLegend] = useState(savedUi.showLegend)
  const [showHoverTip, setShowHoverTip] = useState(savedUi.showHoverTip)
  const [fpMode, setFpMode] = useState<FootprintMode>(savedUi.fpMode)
  const [fpBinMult, setFpBinMult] = useState(savedUi.fpBinMult)
  const [chartEpoch, setChartEpoch] = useState(0)
  const [vwapSource, setVwapSource] = useState<VwapSource>(savedUi.vwapSource)
  const [vwapSession, setVwapSession] = useState<VwapSession>(savedUi.vwapSession)
  const [vwapBandsRaw, setVwapBandsRaw] = useState(savedUi.vwapBandsRaw)
  const [showVwapSettings, setShowVwapSettings] = useState(false)
  const [paneLayouts, setPaneLayouts] = useState<PaneLayout[]>([])
  const [panelMax, setPanelMax] = useState(false)
  const dataKey = useRef<string>('')
  const study = useChartStudy()

  const unitLabel = unit === 'quote' ? 'USDT' : 'BASE'

  useEffect(() => {
    saveChartUi({
      unit,
      showSignals,
      showTrades,
      showMtfLevels,
      showVwap,
      showFootprint,
      showVaz,
      showCot,
      showMinMax,
      showLegend,
      showHoverTip,
      fpMode,
      fpBinMult,
      vwapSource,
      vwapSession,
      vwapBandsRaw,
    })
  }, [
    unit,
    showSignals,
    showTrades,
    showMtfLevels,
    showVwap,
    showFootprint,
    showVaz,
    showCot,
    showMinMax,
    showLegend,
    showHoverTip,
    fpMode,
    fpBinMult,
    vwapSource,
    vwapSession,
    vwapBandsRaw,
  ])
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
      showMtfLevels,
      proMode,
      proMtfMode,
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
      timeScale: {
        borderColor: '#30363d',
        timeVisible: true,
        timeZone: 'Asia/Kolkata',
        locale: 'en-IN',
      },
      rightPriceScale: {
        borderColor: '#30363d',
        scaleMargins: { top: 0.06, bottom: 0.08 },
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
    candleSeriesRef.current = candles
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
        const path = Array.isArray(tr.trail_path) ? tr.trail_path : []
        const hasTrail = path.length >= 2
        const initStop = Number(tr.stop_init ?? path[0]?.stop ?? tr.stop)
        const stopPx = hasTrail ? initStop : Number(tr.stop)
        const beOn = flagOn(data.params?.break_even ?? data.stats?.break_even ?? data.break_even)
        const slOn = flagOn(data.params?.sl_on ?? data.stats?.sl_on)
        const { lock: beLockPx } = bePrices(
          tr,
          data.params,
          data.symbol,
          Number(tr.lots ?? data.volume),
        )
        let tBe = tr.be_moved_time ? snap(tr.be_moved_time) : null
        if (tBe != null) {
          if (tBe < t0) tBe = t0
          if (tBe > t1) tBe = t1
        }

        addRay(t0, t1, tr.entry_price, '#f0b429', LineStyle.Solid, 2, `${tagIn} @ ${fmt2(tr.entry_price)}`)
        const far = (px: number) => !Number.isFinite(px) || Math.abs(px) >= 1e8
        if (!far(tr.target)) {
          addRay(t0, t1, tr.target, '#3fb950', LineStyle.Dashed, 1, `${tagTp} @ ${fmt2(tr.target)}`)
        }
        if (slOn && !far(initStop)) {
          const slEnd = beOn && beLocked && tBe != null && tBe > t0 ? tBe : t1
          addRay(t0, slEnd, initStop, '#f85149', LineStyle.Dashed, 1, `${tagSl} @ ${fmt2(initStop)}`)
        } else if (!beOn && !far(stopPx)) {
          addRay(t0, t1, stopPx, '#f85149', LineStyle.Dashed, 1, `${tagSl} @ ${fmt2(stopPx)}`)
        }
        if (beOn) {
          const level0 = Number(tr.entry_price)
          const level1 = Number.isFinite(beLockPx) ? beLockPx : Number(tr.be_lock ?? tr.stop)
          if (beLocked && tBe != null && tBe > t0) {
            if (!far(level0)) {
              addRay(t0, tBe, level0, BE_WHITE, TRAIL_DOTTED, 1, `BE @ ${fmt2(level0)}`)
            }
            if (!far(level1)) {
              addRay(tBe, t1, level1, BE_WHITE, TRAIL_DOTTED, 1, `BE @ ${fmt2(level1)}`)
            }
          } else if (beLocked && !far(level1)) {
            addRay(t0, t1, level1, BE_WHITE, TRAIL_DOTTED, 1, `BE @ ${fmt2(level1)}`)
          } else if (!far(level0)) {
            addRay(t0, t1, level0, BE_WHITE, TRAIL_DOTTED, 1, `BE @ ${fmt2(level0)}`)
          }
        }

        if (hasTrail) {
          const stairs = staircaseFromStops(
            path.map((p) => ({ time: snap(p.time), value: Number(p.stop) })),
          )
          if (stairs.length >= 2) {
            const trail = chart.addSeries(LineSeries, {
              color: TRAIL_CYAN,
              lineWidth: 1,
              lineStyle: TRAIL_DOTTED,
              lastValueVisible: false,
              priceLineVisible: false,
            })
            trail.setData(stairs.map((p) => ({ time: p.time as never, value: p.value })))
          }
        }

        const exitPin = chart.addSeries(LineSeries, {
          color: '#a371f7',
          lineWidth: 2,
          lastValueVisible: false,
          priceLineVisible: false,
        })
        exitPin.setData([{ time: t1 as never, value: tr.exit_price }])
      })
    }

    // Pro-MTF: HTF invalidator levels drawn on the LTF chart (horizontal segments)
    if (proMtfMode && showMtfLevels && data.mtf_bias?.length && barTimes.length) {
      const events = data.mtf_bias
      const lastT = barTimes[barTimes.length - 1]
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        let t0 = snap(e.time)
        let t1 = i + 1 < events.length ? snap(events[i + 1].time) : lastT
        if (t1 < t0) t1 = t0
        if (t1 === t0) {
          const idx = barTimes.indexOf(t0)
          t1 = idx >= 0 && idx + 1 < barTimes.length ? barTimes[idx + 1] : t0 + tfSec
        }
        const bull = String(e.mode).toLowerCase() === 'bull'
        const color = bull ? '#58a6ff' : '#f85149'
        const title = bull
          ? `HTF Buy inv ${fmt2(e.invalid)}`
          : `HTF Sell inv ${fmt2(e.invalid)}`
        // Axis label only for the latest (active) invalidator
        addRay(t0, t1, Number(e.invalid), color, LineStyle.Dashed, 2, title, i === events.length - 1)
      }
    }

    const markers: ChartMarker[] = []
    const tradeLabels: MarkerLabel[] = []

    if (showSignals) {
      if (proMode) {
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
            kind: 'aggr',
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
      } else {
        // Directional / Non-Directional: plain Buy/Sell AGGR markers (no Lo/Sh/Se/Co)
        for (const a of data.aggressive) {
          const t = snap(a.time)
          const sell = a.side === 'Sell'
          markers.push({
            time: t as never,
            position: sell ? 'aboveBar' : 'belowBar',
            color: sell ? '#f85149' : '#58a6ff',
            shape: 'circle',
            kind: 'aggr',
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
        const lotsN = Number(tr.lots ?? data.volume)
        const lotsLblTr = fmt2(lotsN)
        // Triangles for entries (distinct from AGGR circles)
        markers.push({
          time: tEntry as never,
          position: entryPos,
          color: entryColor,
          shape: short ? 'arrowDown' : 'arrowUp',
          kind: 'trade',
        })
        tradeLabels.push({
          time: tEntry,
          price: tr.entry_price,
          position: entryPos,
          color: entryColor,
          line1: tagIn,
          line2: `${fmt2(tr.entry_price)} - ${lotsLblTr}`,
        })
        for (const sf of tr.scale_fills ?? []) {
          const tAdd = snap(sf.time)
          markers.push({
            time: tAdd as never,
            position: entryPos,
            color: '#f0b429',
            shape: short ? 'arrowDown' : 'arrowUp',
            kind: 'trade',
          })
          tradeLabels.push({
            time: tAdd,
            price: Number(sf.price),
            position: entryPos,
            color: '#f0b429',
            line1: `${tagIn} add`,
            line2: `${fmt2(Number(sf.price))} - ${fmt2(Number(sf.lots))}`,
          })
        }

        const reason = (tr.exit_reason || '').toUpperCase()
        const exitRev = reason === 'LR' || reason === 'SR'
        const hitBe = reason === 'LB' || reason === 'SB'
        const hitMtf =
          reason === 'LMTFX' ||
          reason === 'SMTFX' ||
          reason === 'LMTF' ||
          reason === 'SMTF'
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
              : hitMtf
                ? reason.startsWith('S')
                  ? '#f85149'
                  : '#58a6ff'
                : '#a371f7'
        const tExit = snap(tr.exit_time)
        markers.push({
          time: tExit as never,
          position: exitPos,
          color: exitColor,
          shape: 'circle',
          kind: 'trade',
        })
        tradeLabels.push({
          time: tExit,
          price: tr.exit_price,
          position: exitPos,
          color: exitColor,
          line1: String(tr.exit_reason || ''),
          line2: `${fmt2(tr.exit_price)} - ${lotsLblTr}`,
        })
      }
    }

    markers.sort((a, b) => Number(a.time) - Number(b.time))
    const markerApi = markers.length ? createSeriesMarkers(candles, []) : null
    const applyMarkerSize = () => {
      if (!markerApi) return
      const r = chart.timeScale().getVisibleLogicalRange()
      if (!r) return
      const barPx = Math.max(1, (el.clientWidth - 56) / Math.max(1, r.to - r.from))
      const showAggr = barPx >= AGGR_MIN_BAR_PX
      markerApi.setMarkers(
        markers
          .filter((m) => m.kind !== 'aggr' || showAggr)
          .map((m) => {
            const { kind, text, ...rest } = m
            return {
              ...rest,
              size: markerSizeFromBarPx(barPx, kind),
              text: barPx >= 12 ? text : undefined,
            }
          }),
      )
    }
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
        trade: buildTradeTip(data, t),
      })
    }
    chart.subscribeCrosshairMove(onMove as never)

    const onRange = () => {
      const r = chart.timeScale().getVisibleLogicalRange()
      if (r) saveChartRange({ from: r.from, to: r.to })
      applyMarkerSize()
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    const padRightLogical = (extra = 14) => {
      const r = chart.timeScale().getVisibleLogicalRange()
      if (!r) return
      chart.timeScale().setVisibleLogicalRange({ from: r.from, to: r.to + extra })
    }
    const saved = loadChartRange()
    if (saved) {
      try {
        chart.timeScale().setVisibleLogicalRange({
          from: saved.from,
          to: saved.to + 14,
        })
      } catch {
        chart.timeScale().fitContent()
        padRightLogical(14)
      }
    } else {
      chart.timeScale().fitContent()
      padRightLogical(14)
    }
    applyMarkerSize()

    const onResize = () => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
      chart.resize(el.clientWidth, el.clientHeight)
      requestAnimationFrame(syncPaneOverlays)
    }
    onResize()
    window.addEventListener('resize', onResize)
    const detachPricePan = attachCandlePricePan(chart, el)
    requestAnimationFrame(syncPaneOverlays)
    setChartEpoch((n) => n + 1)

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
      candleSeriesRef.current = null
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
    showMtfLevels,
    proMode,
    proMtfMode,
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
    const ts = chartRef.current?.timeScale()
    ts?.fitContent()
    const r = ts?.getVisibleLogicalRange()
    if (r) {
      ts?.setVisibleLogicalRange({ from: r.from, to: r.to + 14 })
      const padded = ts?.getVisibleLogicalRange()
      if (padded) saveChartRange({ from: padded.from, to: padded.to })
    }
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
    const panes = panesRef.current
    const pane = panes.find((p) => p.id() === paneId)
    if (!pane) return
    const priceId = panes[0]?.id()
    try {
      // Price-pane ⛶: hide Vol/Δ/Δ% (do not use library "maximized" — it stacks
      // those series onto the candle pane). Second click restores them.
      if (paneId === priceId && state === 'maximized') {
        const rest = panes.slice(1)
        const collapsed =
          rest.length > 0 && rest.every((p) => p.options().state === 'minimized')
        for (const p of rest) {
          p.applyOptions({ state: collapsed ? 'normal' : 'minimized' })
        }
        requestAnimationFrame(syncPaneOverlays)
        return
      }
      const cur = pane.options().state
      const next = cur === state ? 'normal' : state
      if (next === 'maximized') {
        for (const p of panes) {
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
  const priceOnly =
    paneLayouts.length > 1 && paneLayouts.slice(1).every((p) => p.state === 'minimized')

  return (
    <div
      className={`panel chart-panel${panelMax ? ' panel-maximized' : ''}`}
      style={{ display: visible ? 'flex' : 'none' }}
    >
      <div className="chart-inbar">
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
          {proMtfMode && (
            <label
              className={`ov-toggle ${showMtfLevels ? 'on' : ''}`}
              title="HTF AGGR invalidator (Buy→low, Sell→high) on this chart"
            >
              <input
                type="checkbox"
                checked={showMtfLevels}
                onChange={(e) => setShowMtfLevels(e.target.checked)}
              />
              HTF Invalid
            </label>
          )}
          <label
            className={`ov-toggle ${showFootprint ? 'on' : ''}`}
            title="Order-flow clusters. Zoom in — Japanese candles when bars are too thin."
          >
            <input
              type="checkbox"
              checked={showFootprint}
              onChange={(e) => setShowFootprint(e.target.checked)}
            />
            Footprint
          </label>
          <label
            className={`ov-toggle ${showVaz ? 'on' : ''}`}
            title="Per-candle 70% value area (VAL–VAH) from that bar's volume profile"
          >
            <input
              type="checkbox"
              checked={showVaz}
              onChange={(e) => setShowVaz(e.target.checked)}
            />
            VAZ
          </label>
          <label
            className={`ov-toggle ${showCot ? 'on' : ''}`}
            title="COT High/Low — this candle's delta since its last new high / last new low"
          >
            <input
              type="checkbox"
              checked={showCot}
              onChange={(e) => setShowCot(e.target.checked)}
            />
            COT
          </label>
          <label
            className={`ov-toggle ${showMinMax ? 'on' : ''}`}
            title="Min/Max Delta — highest and lowest running delta reached inside each bar"
          >
            <input
              type="checkbox"
              checked={showMinMax}
              onChange={(e) => setShowMinMax(e.target.checked)}
            />
            Min/Max Δ
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
          <label
            className={`ov-toggle ${showLegend ? 'on' : ''}`}
            title="Show the color key row"
          >
            <input
              type="checkbox"
              checked={showLegend}
              onChange={(e) => setShowLegend(e.target.checked)}
            />
            Legend
          </label>
          <label
            className={`ov-toggle ${showHoverTip ? 'on' : ''}`}
            title="Show the OHLC / volume hover box on the chart"
          >
            <input
              type="checkbox"
              checked={showHoverTip}
              onChange={(e) => setShowHoverTip(e.target.checked)}
            />
            Tip
          </label>
        </div>

        {sel !== null && (
          <button type="button" className="ghost" onClick={() => selectTrade(null)} title="Clear trade selection">
            Trade #{sel + 1} ✕
          </button>
        )}

        {showLegend && (
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
              <span className="lg" title="BreakEven lock">
                <i className="lg-be" /> BE
              </span>
              <span className="lg" title="Trail stop path when Trail is on">
                <i style={{ background: TRAIL_CYAN }} /> Trail
              </span>
            </>
          )}
          {showSignals &&
            (proMode ? (
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
            ) : (
              <>
                <span className="lg">
                  <i style={{ background: '#58a6ff', borderRadius: '50%' }} /> Buy AGGR
                </span>
                <span className="lg">
                  <i style={{ background: '#f85149', borderRadius: '50%' }} /> Sell AGGR
                </span>
              </>
            ))}
          {proMtfMode && showMtfLevels && (
            <>
              <span className="lg" title="Base TF Buy AGGR invalid (low)">
                <i style={{ background: '#58a6ff', height: 2, width: 14 }} /> HTF Buy inv
              </span>
              <span className="lg" title="Base TF Sell AGGR invalid (high)">
                <i style={{ background: '#f85149', height: 2, width: 14 }} /> HTF Sell inv
              </span>
            </>
          )}
          {showFootprint && fpMode === 'profile' && (
            <>
              <span className="lg" title="Total volume at price (left of candle)">
                <i style={{ background: '#58a6ff' }} /> Volume
              </span>
              <span className="lg" title="Ask − Bid (right of candle)">
                <i style={{ background: '#3fb950' }} /> +Δ
              </span>
              <span className="lg" title="Ask − Bid (right of candle)">
                <i style={{ background: '#f85149' }} /> −Δ
              </span>
            </>
          )}
          {showFootprint && fpMode === 'bidask' && (
            <>
              <span className="lg" title="Sell aggressor volume (bid)">
                <i style={{ background: '#f85149' }} /> Bid
              </span>
              <span className="lg" title="Buy aggressor volume (ask)">
                <i style={{ background: '#3fb950' }} /> Ask
              </span>
            </>
          )}
          {showFootprint && fpMode === 'delta' && (
            <>
              <span className="lg" title="Ask − Bid (buy aggression)">
                <i style={{ background: '#3fb950' }} /> +Δ
              </span>
              <span className="lg" title="Ask − Bid (sell aggression)">
                <i style={{ background: '#f85149' }} /> −Δ
              </span>
            </>
          )}
          {showFootprint && fpMode === 'volume' && (
            <span className="lg" title="Bid + Ask volume at price">
              <i style={{ background: '#58a6ff' }} /> Volume
            </span>
          )}
          {showFootprint && (
            <>
              <span className="lg" title="Volume POC — gold outline on the max-volume bar">
                <i style={{ background: '#f0b429' }} /> Vol POC
              </span>
              {(fpMode === 'profile' || fpMode === 'delta') && (
                <span className="lg" title="Delta POC — gold outline on the max |Ask − Bid| bar">
                  <i style={{ background: '#f0b429' }} /> Δ POC
                </span>
              )}
            </>
          )}
          {showVaz && (
            <span className="lg" title="70% value area of each candle (VAL–VAH)">
              <i style={{ background: 'rgba(240,180,41,0.55)' }} /> VAZ
            </span>
          )}
          {showCot && (
            <>
              <span className="lg" title="This candle's delta since its last new high">
                <i style={{ background: '#3fb950' }} /> CH
              </span>
              <span className="lg" title="This candle's delta since its last new low">
                <i style={{ background: '#f85149' }} /> CL
              </span>
            </>
          )}
          {showMinMax && (
            <>
              <span className="lg" title="Highest running delta inside the bar">
                <i style={{ background: '#3fb950' }} /> Max Δ
              </span>
              <span className="lg" title="Lowest running delta inside the bar">
                <i style={{ background: '#f85149' }} /> Min Δ
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
        )}

        <button
          type="button"
          className="ghost panel-max-btn"
          title={panelMax ? 'Restore chart panel' : 'Maximize chart panel'}
          onClick={() => setPanelMax((v) => !v)}
        >
          {panelMax ? '❐' : '⛶'}
        </button>
      </div>

      {(showCot || showMinMax) && !showFootprint && !showVaz && (
        <div className="vwap-settings" role="group" aria-label="Order-flow labels">
          <span className="vwap-settings-hint">
            {showCot
              ? 'COT CH/CL = this candle Δ since last new high / last new low. Gold dash = CH>0 or CL<0'
              : ''}
            {showCot && showMinMax ? ' · ' : ''}
            {showMinMax ? 'Min/Max Δ = running-delta extremes. Cyan dash if |value| is 0–9' : ''}
            {' · follows '}
            {unitLabel}
          </span>
        </div>
      )}

      {(showFootprint || showVaz) && (
        <div className="vwap-settings" role="group" aria-label="Footprint settings">
          {showFootprint && (
            <>
              <span>Mode</span>
              <div className="unit-toggle" role="group" aria-label="Footprint display mode">
                <button
                  type="button"
                  className={fpMode === 'profile' ? 'active' : 'ghost'}
                  title="Volume profile left of the candle, delta profile right"
                  onClick={() => setFpMode('profile')}
                >
                  Profile
                </button>
                <button
                  type="button"
                  className={fpMode === 'bidask' ? 'active' : 'ghost'}
                  title="Bid profile left, ask profile right"
                  onClick={() => setFpMode('bidask')}
                >
                  Bid/Ask
                </button>
                <button
                  type="button"
                  className={fpMode === 'delta' ? 'active' : 'ghost'}
                  title="Delta profile (bar width = |Ask − Bid|)"
                  onClick={() => setFpMode('delta')}
                >
                  Delta
                </button>
                <button
                  type="button"
                  className={fpMode === 'volume' ? 'active' : 'ghost'}
                  title="Volume profile (bar width = Bid + Ask)"
                  onClick={() => setFpMode('volume')}
                >
                  Total Vol
                </button>
              </div>
            </>
          )}
          <label title="Cluster height = symbol tick × this multiplier">
            Bin ×
            <input
              type="number"
              min={1}
              max={10000}
              step={1}
              list="fp-bin-presets"
              value={fpBinMult}
              onChange={(e) => {
                const n = Math.max(1, Math.floor(Number(e.target.value) || 1))
                setFpBinMult(Math.min(10000, n))
              }}
            />
          </label>
          <datalist id="fp-bin-presets">
            <option value="1" />
            <option value="2" />
            <option value="5" />
            <option value="10" />
            <option value="20" />
            <option value="25" />
            <option value="50" />
            <option value="100" />
          </datalist>
          <span className="vwap-settings-hint">
            Bin = {fmtTick(symbolTickSize(data.symbol))} × {fpBinMult} ={' '}
            {fmtTick(symbolTickSize(data.symbol) * fpBinMult)}
            {showVaz ? ' · VAZ = 70% value area per candle' : ''}
            {showCot ? ' · COT = this candle Δ since last new high / last new low' : ''}
            {showMinMax ? ' · Min/Max Δ = running-delta extremes of the bar' : ''}
          </span>
        </div>
      )}

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
        {showHoverTip && tip && (
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
            <div className="tt-trade">
              {tip.trade.side === 'Flat' ? (
                <div className="tt-flat">Flat</div>
              ) : (
                <>
                  <div className="tt-flow">
                    <span>
                      Side{' '}
                      <b className={tip.trade.side === 'Long' ? 'pos' : 'neg'}>{tip.trade.side}</b>
                    </span>
                    <span>
                      Entry <b>{fmt2(tip.trade.entry)}</b>
                    </span>
                    {tip.trade.lots != null && (
                      <span>
                        Lots <b>{fmt2(tip.trade.lots)}</b>
                      </span>
                    )}
                  </div>
                  {(tip.trade.sl != null ||
                    tip.trade.tp != null ||
                    tip.trade.be ||
                    tip.trade.trail != null) && (
                    <div className="tt-flow">
                      {tip.trade.sl != null && (
                        <span>
                          SL <b className="neg">{fmt2(tip.trade.sl)}</b>
                        </span>
                      )}
                      {tip.trade.tp != null && (
                        <span>
                          TP <b className="pos">{fmt2(tip.trade.tp)}</b>
                        </span>
                      )}
                      {tip.trade.be && (
                        <>
                          <span>
                            BE <b>{fmt2(tip.trade.be.px)}</b>
                          </span>
                          {tip.trade.be.state === 'waiting' && tip.trade.be.arm != null && (
                            <span>
                              arm <b className="tt-be-wait">{fmt2(tip.trade.be.arm)}</b>
                            </span>
                          )}
                        </>
                      )}
                      {tip.trade.trail != null && (
                        <span>
                          Trail <b className="tt-trail">{fmt2(tip.trade.trail)}</b>
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        <div className="chart-host" ref={hostRef} />
        <FootprintOverlay
          chartRef={chartRef}
          seriesRef={candleSeriesRef}
          wrapRef={wrapRef}
          chartEpoch={chartEpoch}
          show={showFootprint}
          showVaz={showVaz}
          showCot={showCot}
          showMinMax={showMinMax}
          symbol={data.symbol}
          tf={data.tf_minutes}
          unit={unit}
          mode={fpMode}
          binMult={fpBinMult}
          barTimes={barTimes}
        />
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
                  className={`pane-btn${i === 0 ? (priceOnly ? ' on' : '') : pl.state === 'maximized' ? ' on' : ''}`}
                  title={
                    i === 0
                      ? priceOnly
                        ? 'Show Vol / Δ panes'
                        : 'Price only — hide Vol / Δ panes'
                      : pl.state === 'maximized'
                        ? 'Restore pane'
                        : 'Maximize pane'
                  }
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
