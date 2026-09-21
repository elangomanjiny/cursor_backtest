import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
import { attachCandlePricePan, clipPlotCanvases, fitPriceToCandles } from '../chartPricePan'
import { computeVwap, parseBandMultipliers, type VwapSession, type VwapSource } from '../computeVwap'
import { computeSupertrend } from '../computeSupertrend'
import {
  FootprintOverlay,
  type CandleSeries,
  type FootprintMode,
  type StavpPlace,
  type StavpProfileRow,
} from '../FootprintOverlay'
import { fmt2 } from '../format'

export type PriceKind = 'candle' | 'bar' | 'line'
export type Unit = 'quote' | 'base'

type Props = {
  bars: OrderflowBar[]
  symbol: string
  tf: number
  visible?: boolean
  studiesTabHost?: HTMLElement | null
  studiesDrawerHost?: HTMLElement | null
  onStudiesChange?: (open: boolean, pinned: boolean) => void
}

const VWAP_COLOR = '#26a69a'
const VWAP_BAND_COLORS = ['#26a69a99', '#26a69a66', '#26a69a44']
const FLOW_MAX = 1440
const RIGHT_PAD = 16

type HistKey = 'vol' | 'delta' | 'dp' | 'cvd'
const HIST_KEYS: HistKey[] = ['vol', 'delta', 'dp', 'cvd']
const HIST_LABEL: Record<HistKey, string> = {
  vol: 'Vol',
  delta: 'Δ',
  dp: 'Δ%',
  cvd: 'CVD',
}
type MaType = 'sma' | 'ema'
type MaSrc = 'close' | 'hl2' | 'hlc3' | 'ohlc4'
const GOLD = '#f0b429'

type HistHandle = {
  pane: IPaneApi
  series: { setData: (d: readonly HistogramData[]) => void }
  thrUp?: { setData: (d: readonly HistogramData[]) => void }
  thrDn?: { setData: (d: readonly HistogramData[]) => void }
}
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
function stripAnom(kind: 'max' | 'min' | 'ch' | 'cl', v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return ''
  if (kind === 'ch' && v > 0) return 'anom-ch'
  if (kind === 'cl' && v < 0) return 'anom-cl'
  if ((kind === 'max' || kind === 'min') && Math.abs(v) < 1) return 'anom-zero'
  return v >= 0 ? 'pos' : 'neg'
}

function maSrcOf(b: OrderflowBar, src: MaSrc): number {
  const o = Number(b.open)
  const h = Number(b.high)
  const l = Number(b.low)
  const c = Number(b.close)
  if (src === 'hl2') return (h + l) / 2
  if (src === 'hlc3') return (h + l + c) / 3
  if (src === 'ohlc4') return (o + h + l + c) / 4
  return c
}

function maSeries(
  bars: OrderflowBar[],
  period: number,
  type: MaType,
  src: MaSrc,
): { time: number; value: number }[] {
  const n = Math.max(1, Math.round(period) || 1)
  const vals = bars.map((b) => maSrcOf(b, src))
  const out: { time: number; value: number }[] = []
  if (type === 'ema') {
    let seed = 0
    for (let i = 0; i < n && i < vals.length; i++) seed += vals[i]
    seed /= Math.min(n, vals.length)
    let ema = seed
    const k = 2 / (n + 1)
    for (let i = 0; i < vals.length; i++) {
      if (i < n - 1) continue
      if (i === n - 1) ema = seed
      else ema = vals[i] * k + ema * (1 - k)
      out.push({ time: bars[i].time, value: ema })
    }
    return out
  }
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    sum += vals[i]
    if (i >= n) sum -= vals[i - n]
    if (i >= n - 1) out.push({ time: bars[i].time, value: sum / n })
  }
  return out
}

function candlePoint(b: OrderflowBar, kind: PriceKind, thr: number) {
  const gold = Math.abs(Number(b.delta_pct) || 0) >= Math.abs(thr || 0) && Math.abs(thr || 0) > 0
  const up = b.close >= b.open
  const tone = gold ? GOLD : up ? '#3fb950' : '#f85149'
  if (kind === 'line') {
    return {
      time: b.time as never,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      color: 'rgba(0,0,0,0)',
      borderColor: 'rgba(0,0,0,0)',
      wickColor: 'rgba(0,0,0,0)',
    }
  }
  if (kind === 'bar') {
    return {
      time: b.time as never,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      color: 'rgba(0,0,0,0)',
      borderColor: tone,
      wickColor: tone,
    }
  }
  return {
    time: b.time as never,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    color: tone,
    borderColor: tone,
    wickColor: tone,
  }
}

function fmtIstShort(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function statCls(kind: 'max' | 'min' | 'ch' | 'cl', v: number | undefined): string {
  return stripAnom(kind, v)
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
  ts: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  delta: number
  delta_pct: number
  cvd?: number
  vwap?: number
  vwapBands?: { mult: number; up: number; dn: number }[]
  ma?: number
  st?: number
  stTrend?: 1 | -1
  stavp?: { vah: number; poc: number; val: number }
  vaz?: { vah: number; poc: number; val: number }
  idh?: number
  idl?: number
  minD?: number
  maxD?: number
  ch?: number
  cl?: number
}

function sessionDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

function lookupVazBar(map: Map<number, FootprintBar>, t: number, tfSec: number): FootprintBar | undefined {
  const hit = map.get(t) ?? map.get(Math.floor(t)) ?? map.get(Math.round(t))
  if (hit) return hit
  const slack = Math.max(1, tfSec)
  for (const [k, b] of map) {
    if (Math.abs(Number(k) - t) <= slack) return b
  }
  return undefined
}

function vazFromFlow(f: FootprintBar | undefined, unit: Unit): Tip['vaz'] {
  if (!f) return undefined
  const val = unit === 'quote' ? f.val : (f.valBase ?? f.val)
  const vah = unit === 'quote' ? f.vah : (f.vahBase ?? f.vah)
  const poc = unit === 'quote' ? f.poc : (f.pocBase ?? f.poc)
  if (val == null || vah == null || !Number.isFinite(val) || !Number.isFinite(vah)) return undefined
  const lo = Math.min(Number(val), Number(vah))
  const hi = Math.max(Number(val), Number(vah))
  const mid = poc != null && Number.isFinite(Number(poc)) ? Number(poc) : (lo + hi) / 2
  return { val: lo, poc: mid, vah: hi }
}

function stavpVaFrom(
  rows: StavpProfileRow[],
  time: number,
  unit: Unit,
): Tip['stavp'] {
  const row = rows.find((r) => time >= r.t0 && time < r.t1)
  if (!row) return undefined
  let val = unit === 'quote' ? row.val : (row.valBase ?? row.val)
  let vah = unit === 'quote' ? row.vah : (row.vahBase ?? row.vah)
  let poc = unit === 'quote' ? row.poc : (row.pocBase ?? row.poc)
  const dev = row.developing
  if (dev?.length) {
    let pt = dev[0]
    for (const p of dev) {
      if (p.time <= time) pt = p
      else break
    }
    val = unit === 'quote' ? pt.val : (pt.valBase ?? pt.val)
    vah = unit === 'quote' ? pt.vah : (pt.vahBase ?? pt.vah)
    poc = unit === 'quote' ? pt.poc : (pt.pocBase ?? pt.poc)
  }
  if (val == null || vah == null || !Number.isFinite(val) || !Number.isFinite(vah)) return undefined
  const lo = Math.min(Number(val), Number(vah))
  const hi = Math.max(Number(val), Number(vah))
  const mid = poc != null && Number.isFinite(Number(poc)) ? Number(poc) : (lo + hi) / 2
  return { val: lo, poc: mid, vah: hi }
}

function vwapBandList(
  vp: { bands: Record<string, number> } | undefined,
  bands: number[],
): Tip['vwapBands'] {
  if (!vp) return undefined
  return bands.map((mult) => ({
    mult,
    up: vp.bands[`up${mult}`],
    dn: vp.bands[`dn${mult}`],
  }))
}

export function OrderflowChart({
  bars,
  symbol,
  tf,
  visible = true,
  studiesTabHost = null,
  studiesDrawerHost = null,
  onStudiesChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<CandleSeries | null>(null)
  const candleDataRef = useRef<{ setData: (d: ReturnType<typeof candlePoint>[]) => void } | null>(null)
  const maRef = useRef<{
    setData: (d: { time: number; value: number }[]) => void
    applyOptions: (o: Record<string, unknown>) => void
  } | null>(null)
  const histRef = useRef<Partial<Record<HistKey, HistHandle>>>({})
  const panesRef = useRef<IPaneApi[]>([])
  const rangeRef = useRef<{ from: number; to: number } | null>(null)
  const [chartEpoch, setChartEpoch] = useState(0)
  const [unit, setUnit] = useState<Unit>('quote')
  const [priceKind, setPriceKind] = useState<PriceKind>('candle')
  const [fpMode, setFpMode] = useState<FootprintMode>('profile')
  const [fpBinMult, setFpBinMult] = useState(1)
  const [showFootprint, setShowFootprint] = useState(true)
  const [showVaz, setShowVaz] = useState(false)
  const [vazBinMode, setVazBinMode] = useState<'default' | 'custom'>('default')
  const [vazBinMult, setVazBinMult] = useState(1)
  const [showVwap, setShowVwap] = useState(false)
  const [showMa, setShowMa] = useState(false)
  const [maPeriod, setMaPeriod] = useState(21)
  const [maType, setMaType] = useState<MaType>('sma')
  const [maSrc] = useState<MaSrc>('close')
  const [showVp, setShowVp] = useState(false)
  const [showStavp, setShowStavp] = useState(false)
  const [stPeriod, setStPeriod] = useState(10)
  const [stMult, setStMult] = useState(3)
  const [stavpMode, setStavpMode] = useState<FootprintMode>('profile')
  const [stavpBinMode, setStavpBinMode] = useState<'default' | 'custom'>('default')
  const [stavpBinMult, setStavpBinMult] = useState(1)
  const [stavpWidthPct, setStavpWidthPct] = useState(50)
  const [stavpWidthDraft, setStavpWidthDraft] = useState('50')
  const [stavpPlace, setStavpPlace] = useState<StavpPlace>('swings')
  const [stavpProfiles, setStavpProfiles] = useState<StavpProfileRow[]>([])
  const [showIdhl, setShowIdhl] = useState(true)
  const [showBarStats, setShowBarStats] = useState(false)
  const [barStatOn, setBarStatOn] = useState({ ch: true, cl: true, min: true, max: true })
  const [showImb, setShowImb] = useState(false)
  const [showDiv, setShowDiv] = useState(false)
  const [showAbsorb, setShowAbsorb] = useState(false)
  const [absorbMode, setAbsorbMode] = useState<'body' | 'range' | 'extreme'>('range')
  const [absorbBodyPct, setAbsorbBodyPct] = useState(35)
  const [showUa, setShowUa] = useState(false)
  const [showBigVol, setShowBigVol] = useState(false)
  const [showBigAsk, setShowBigAsk] = useState(false)
  const [showBigBid, setShowBigBid] = useState(false)
  const [imbRatio, setImbRatio] = useState(3)
  const [imbConsec, setImbConsec] = useState(1)
  const [imbIgnoreZero, setImbIgnoreZero] = useState(true)
  const [imbMode, setImbMode] = useState<'diagonal' | 'horizontal'>('diagonal')
  const [bigMult, setBigMult] = useState(1)
  const [vpMode, setVpMode] = useState<FootprintMode>('profile')
  const [vpBinMult, setVpBinMult] = useState(1)
  const [vpBinMode, setVpBinMode] = useState<'default' | 'custom'>('default')
  const [vpT0, setVpT0] = useState<number | null>(null)
  const [vpT1, setVpT1] = useState<number | null>(null)
  const [tipOpen, setTipOpen] = useState(true)
  const [paneOn, setPaneOn] = useState<Record<HistKey, boolean>>({
    vol: false,
    delta: false,
    dp: false,
    cvd: false,
  })
  const paneOnRef = useRef(paneOn)
  paneOnRef.current = paneOn
  const [studiesOpen, setStudiesOpen] = useState(false)
  const [studiesPinned, setStudiesPinned] = useState(false)
  const onStudiesChangeRef = useRef(onStudiesChange)
  onStudiesChangeRef.current = onStudiesChange
  const [vwapSource] = useState<VwapSource>('hlc3')
  const [vwapSession] = useState<VwapSession>('binance')
  const [vwapBandsRaw, setVwapBandsRaw] = useState('1,2')
  const [dpThr, setDpThr] = useState(50)
  const [tip, setTip] = useState<Tip | null>(null)
  const [flow, setFlow] = useState<FootprintBar[]>([])
  const [vazBars, setVazBars] = useState<FootprintBar[]>([])
  const vazSigRef = useRef('')
  const [stripCells, setStripCells] = useState<
    { time: number; x: number; w: number; maxD?: number; minD?: number; ch?: number; cl?: number }[]
  >([])
  const [avpX, setAvpX] = useState<{ x0: number | null; x1: number | null }>({ x0: null, x1: null })
  const avpDragRef = useRef<null | 'start' | 'end'>(null)
  const [paneLayouts, setPaneLayouts] = useState<PaneLayout[]>([])
  const flowAc = useRef<AbortController | null>(null)
  const flowTimer = useRef<number | null>(null)

  const binSafe = Math.max(1, Math.round(fpBinMult) || 1)
  const vpBinSafe =
    vpBinMode === 'custom' ? Math.max(1, Math.round(vpBinMult) || 1) : binSafe
  const vazBinSafe =
    vazBinMode === 'custom' ? Math.max(1, Math.round(vazBinMult) || 1) : binSafe
  const stavpBinSafe =
    stavpBinMode === 'custom' ? Math.max(1, Math.round(stavpBinMult) || 1) : binSafe
  const stPeriodSafe = Math.min(200, Math.max(1, Math.round(stPeriod) || 10))
  const stMultSafe = Math.min(20, Math.max(0.1, Number(stMult) || 3))
  const stavpWidthSafe = Math.min(100, Math.max(1, Math.round(stavpWidthPct) || 50))
  const unitLabel = unit === 'quote' ? 'USDT' : 'BASE'
  const kind = priceKind
  const showVpRef = useRef(showVp)
  showVpRef.current = showVp
  const vpPickRef = useRef<'start' | 'end'>('start')
  const vpRangeRef = useRef({ t0: vpT0, t1: vpT1 })
  vpRangeRef.current = { t0: vpT0, t1: vpT1 }

  const vwapBands = useMemo(() => parseBandMultipliers(vwapBandsRaw), [vwapBandsRaw])
  const vwapSettings = useMemo(
    () => ({
      source: vwapSource,
      session: vwapSession,
      bands: vwapBands.length ? vwapBands : [1, 2],
    }),
    [vwapSource, vwapSession, vwapBands],
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
  const maPts = useMemo(
    () => (showMa ? maSeries(bars, maPeriod, maType, maSrc) : []),
    [showMa, bars, maPeriod, maType, maSrc],
  )
  const maByTime = useMemo(() => {
    const m = new Map<number, number>()
    for (const p of maPts) m.set(p.time, p.value)
    return m
  }, [maPts])
  const stavpCalc = useMemo(
    () =>
      showStavp
        ? computeSupertrend(bars, stPeriodSafe, stMultSafe, Math.max(1, tf) * 60)
        : { points: [], legs: [] },
    [showStavp, bars, stPeriodSafe, stMultSafe, tf],
  )
  const stByTime = useMemo(() => {
    const m = new Map<number, { value: number; trend: 1 | -1 }>()
    for (const p of stavpCalc.points) m.set(p.time, { value: p.value, trend: p.trend })
    return m
  }, [stavpCalc.points])
  const barTimes = useMemo(() => bars.map((b) => b.time), [bars])
  const guides = useMemo(
    () => bars.map((b) => ({ time: b.time, high: b.high, low: b.low })),
    [bars],
  )
  const ofSignalBars = useMemo(
    () =>
      bars.map((b) => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: volOf(b, unit),
        delta: deltaOf(b, unit),
        range: b.range ?? Math.max(0, b.high - b.low),
        rangeUpper: b.rangeUpper,
        volMid: unit === 'base' ? b.volMidBase : b.volMidQuote,
        volStd: unit === 'base' ? b.volStdBase : b.volStdQuote,
        dAbsMid: unit === 'base' ? b.dAbsMidBase : b.dAbsMidQuote,
        dAbsStd: unit === 'base' ? b.dAbsStdBase : b.dAbsStdQuote,
        hh: Boolean(b.hh),
        ll: Boolean(b.ll),
      })),
    [bars, unit],
  )
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
  const vazByTime = useMemo(() => {
    const m = new Map<number, FootprintBar>()
    for (const b of vazBars) m.set(Number(b.time), b)
    return m
  }, [vazBars])
  const cvdByTime = useMemo(() => {
    const m = new Map<number, number>()
    for (const p of sessionCvd(bars, unit)) m.set(Number(p.time), Number(p.value))
    return m
  }, [bars, unit])
  const idhlByTime = useMemo(() => {
    const m = new Map<number, { idh: number; idl: number }>()
    let day = ''
    let hi = -Infinity
    let lo = Infinity
    for (const b of bars) {
      const d = sessionDay(b.time)
      if (d !== day) {
        day = d
        hi = b.high
        lo = b.low
      } else {
        if (b.high > hi) hi = b.high
        if (b.low < lo) lo = b.low
      }
      m.set(b.time, { idh: hi, idl: lo })
    }
    return m
  }, [bars])
  const hoverRef = useRef({
    byTime,
    flowByTime,
    cvdByTime,
    idhlByTime,
    unit,
    vwapSeries,
    showVwap,
    vwapBandMults: vwapSettings.bands,
    maByTime,
    showMa,
    showStavp,
    stByTime,
    stavpProfiles,
    showVaz,
    vazByTime,
  })
  hoverRef.current = {
    byTime,
    flowByTime,
    cvdByTime,
    idhlByTime,
    unit,
    vwapSeries,
    showVwap,
    vwapBandMults: vwapSettings.bands,
    maByTime,
    showMa,
    showStavp,
    stByTime,
    stavpProfiles,
    showVaz,
    vazByTime,
  }
  const barsRef = useRef(bars)
  barsRef.current = bars
  const flowByTimeRef = useRef(flowByTime)
  flowByTimeRef.current = flowByTime
  const unitRef = useRef(unit)
  unitRef.current = unit
  const tfRef = useRef(tf)
  tfRef.current = tf
  const dpThrRef = useRef(dpThr)
  dpThrRef.current = dpThr

  const lastBar = bars[bars.length - 1]
  const lastFlow = lastBar ? flowByTime.get(lastBar.time) : undefined
  const lastIdhl = lastBar ? idhlByTime.get(lastBar.time) : undefined
  const lastVp = lastBar && showVwap ? vwapSeries.find((p) => p.time === lastBar.time) : undefined
  const inspectSrc: Tip | null = tip ?? (lastBar
    ? {
        time: lastBar.time_iso,
        ts: lastBar.time,
        open: lastBar.open,
        high: lastBar.high,
        low: lastBar.low,
        close: lastBar.close,
        volume: volOf(lastBar, unit),
        delta: deltaOf(lastBar, unit),
        delta_pct: lastBar.delta_pct,
        cvd: cvdByTime.get(lastBar.time),
        vwap: lastVp?.vwap,
        vwapBands: vwapBandList(lastVp, vwapSettings.bands),
        ma: showMa ? maByTime.get(lastBar.time) : undefined,
        st: showStavp ? stByTime.get(lastBar.time)?.value : undefined,
        stTrend: showStavp ? stByTime.get(lastBar.time)?.trend : undefined,
        stavp: showStavp ? stavpVaFrom(stavpProfiles, lastBar.time, unit) : undefined,
        idh: lastIdhl?.idh,
        idl: lastIdhl?.idl,
        minD: unit === 'quote' ? lastFlow?.minDeltaQuote : lastFlow?.minDelta,
        maxD: unit === 'quote' ? lastFlow?.maxDeltaQuote : lastFlow?.maxDelta,
        ch: unit === 'quote' ? lastFlow?.cotHighQuote : lastFlow?.cotHigh,
        cl: unit === 'quote' ? lastFlow?.cotLowQuote : lastFlow?.cotLow,
      }
    : null)
  const inspect: Tip | null =
    inspectSrc == null
      ? null
      : {
          ...inspectSrc,
          vaz: showVaz
            ? vazFromFlow(lookupVazBar(vazByTime, inspectSrc.ts, Math.max(1, tf) * 60), unit)
            : undefined,
        }

  const loadFlowVisible = () => {
    const list = barsRef.current
    if (!list.length) return
    const chart = chartRef.current
    const log = chart?.timeScale().getVisibleLogicalRange()
    let from = 0
    let to = list.length - 1
    if (log) {
      from = Math.max(0, Math.floor(log.from))
      to = Math.min(list.length - 1, Math.ceil(log.to))
    }
    if (to - from + 1 > FLOW_MAX) from = Math.max(0, to - FLOW_MAX + 1)
    const t0 = list[from].time
    const t1 = list[to].time + tfRef.current * 60
    flowAc.current?.abort()
    const ac = new AbortController()
    flowAc.current = ac
    void fetchFlowStats({ symbol, tf: tfRef.current, t0, t1, max_bars: FLOW_MAX }, ac.signal)
      .then((r) => {
        if (!ac.signal.aborted) setFlow(r.bars || [])
      })
      .catch(() => {
        if (!ac.signal.aborted) setFlow([])
      })
  }

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
      const thr = Math.abs(Number(dpThrRef.current) || 50)
      return bars.map((b) => ({
        time: b.time,
        value: b.delta_pct,
        color: Math.abs(b.delta_pct) >= thr ? GOLD : signed(b.delta_pct),
      }))
    }
    return sessionCvd(bars, unit)
  }

  const addHistPane = (key: HistKey) => {
    const chart = chartRef.current
    if (!chart || histRef.current[key]) return
    const pane = chart.addPane({ height: 56, minHeight: 22 })
    try {
      pane.priceScale('right').applyOptions({ minimumWidth: 108 } as never)
    } catch {
      /* ignore */
    }
    const series = pane.addSeries(HistogramSeries, {
      color: '#3fb950',
      lastValueVisible: true,
      priceLineVisible: false,
      priceFormat: { type: 'volume' },
    })
    try {
      series.applyOptions({
        priceFormat: { type: 'custom', formatter: (p: number) => fmtPlot(p) },
      } as never)
    } catch {
      /* ignore */
    }
    series.setData(histData(key))
    const handle: HistHandle = { pane, series }
    if (key === 'dp') {
      const thr = Math.abs(Number(dpThrRef.current) || 50)
      const up = pane.addSeries(LineSeries, {
        color: '#f0b429',
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      })
      const dn = pane.addSeries(LineSeries, {
        color: '#f0b429',
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      })
      const pts = barsRef.current.map((b) => ({ time: b.time, value: thr }))
      const npts = barsRef.current.map((b) => ({ time: b.time, value: -thr }))
      up.setData(pts)
      dn.setData(npts)
      handle.thrUp = up
      handle.thrDn = dn
    }
    histRef.current[key] = handle
  }

  const dropHistPane = (key: HistKey) => {
    const chart = chartRef.current
    const h = histRef.current[key]
    if (!h) return
    try {
      if (chart) chart.removePane(h.pane)
    } catch {
      /* ignore */
    }
    delete histRef.current[key]
  }

  const stretchMainPane = () => {
    const chart = chartRef.current
    const host = hostRef.current
    if (!chart || !host) return
    const hostH = host.clientHeight
    const hostW = host.clientWidth
    if (hostH < 40 || hostW < 40) return
    try {
      chart.applyOptions({ width: hostW, height: hostH })
      chart.resize(hostW, hostH)
      const panes = chart.panes()
      const main = panes[0]
      if (main) {
        if (panes.length <= 1) {
          main.applyOptions({ minHeight: 80, height: Math.max(120, hostH - 36) })
        } else {
          let used = 0
          for (let i = 1; i < panes.length; i++) {
            used += panes[i].getSize()?.height ?? 0
          }
          const h = Math.max(120, hostH - used - 32)
          main.applyOptions({ minHeight: 80, height: h })
        }
      }
    } catch {
      /* ignore */
    }
    clipPlotCanvases(host, chart)
  }

  const applyPaneVis = () => {
    const on = paneOnRef.current
    for (const key of HIST_KEYS) {
      if (on[key]) addHistPane(key)
      else dropHistPane(key)
    }
    const el = hostRef.current
    const chart = chartRef.current
    if (el && chart) {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w > 8 && h > 8) {
        chart.applyOptions({ width: w, height: h })
        chart.resize(w, h)
        stretchMainPane()
      }
    }
  }

  const histKeyForPane = (paneId: string): HistKey | null => {
    for (const key of HIST_KEYS) {
      if (histRef.current[key]?.pane.id() === paneId) return key
    }
    return null
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

  const fitCandles = () => {
    const chart = chartRef.current
    if (chart) fitPriceToCandles(chart, barsRef.current)
  }

  const syncFlowStrip = () => {
    const chart = chartRef.current
    const list = barsRef.current
    if (!chart || !list.length) {
      setStripCells([])
      return
    }
    const r = chart.timeScale().getVisibleLogicalRange()
    if (!r) {
      setStripCells([])
      return
    }
    const tfSec = Math.max(1, tfRef.current) * 60
    const from = Math.max(0, Math.floor(r.from))
    const to = Math.min(list.length - 1, Math.ceil(r.to))
    const u = unitRef.current
    const fmap = flowByTimeRef.current
    const cells: typeof stripCells = []
    for (let i = from; i <= to; i++) {
      const b = list[i]
      if (!b) continue
      const mid = chart.timeScale().timeToCoordinate(b.time as never)
      if (mid == null) continue
      const next = chart.timeScale().timeToCoordinate((b.time + tfSec) as never)
      const w = next != null && next > mid ? next - mid : 20
      const f = fmap.get(b.time)
      cells.push({
        time: b.time,
        x: mid - w / 2,
        w,
        maxD: u === 'quote' ? f?.maxDeltaQuote : f?.maxDelta,
        minD: u === 'quote' ? f?.minDeltaQuote : f?.minDelta,
        ch: u === 'quote' ? f?.cotHighQuote : f?.cotHigh,
        cl: u === 'quote' ? f?.cotLowQuote : f?.cotLow,
      })
    }
    setStripCells(cells)
  }

  const syncAvpHandles = () => {
    const chart = chartRef.current
    const { t0, t1 } = vpRangeRef.current
    if (!chart || !showVpRef.current) {
      setAvpX({ x0: null, x1: null })
      return
    }
    const x0 = t0 != null ? chart.timeScale().timeToCoordinate(t0 as never) : null
    const x1 = t1 != null ? chart.timeScale().timeToCoordinate(t1 as never) : null
    setAvpX({ x0, x1 })
  }

  const xToBarTime = (x: number): number | null => {
    const chart = chartRef.current
    const list = barsRef.current
    const host = wrapRef.current
    const log = chart?.timeScale().getVisibleLogicalRange()
    if (!chart || !list.length || !host || !log) return null
    const w = Math.max(1, host.clientWidth - 56)
    const idx = log.from + (x / w) * (log.to - log.from)
    const i = Math.max(0, Math.min(list.length - 1, Math.round(idx)))
    return list[i]?.time ?? null
  }

  useEffect(() => {
    onStudiesChangeRef.current?.(studiesOpen, studiesPinned)
  }, [studiesOpen, studiesPinned])

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
        rightOffset: 8,
      } as never,
      rightPriceScale: {
        borderColor: '#30363d',
        scaleMargins: { top: 0.06, bottom: 0.08 },
        minimumWidth: 108,
        visible: true,
      } as never,
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true },
    })
    chartRef.current = chart

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: kind === 'candle' ? '#3fb950' : 'rgba(0,0,0,0)',
      downColor: kind === 'candle' ? '#f85149' : 'rgba(0,0,0,0)',
      borderVisible: kind === 'bar',
      borderUpColor: '#3fb950',
      borderDownColor: '#f85149',
      wickUpColor: kind === 'line' ? 'rgba(0,0,0,0)' : '#3fb950',
      wickDownColor: kind === 'line' ? 'rgba(0,0,0,0)' : '#f85149',
      visible: kind !== 'line',
      lastValueVisible: kind !== 'line',
    })
    seriesRef.current = candles
    candleDataRef.current = candles
    const maLine = chart.addSeries(LineSeries, {
      color: '#a371f7',
      lineWidth: 2,
      lastValueVisible: true,
      priceLineVisible: false,
      visible: false,
    })
    maRef.current = maLine
    if (showMa) {
      maLine.applyOptions({ visible: true })
      maLine.setData(maSeries(bars, maPeriod, maType, maSrc))
    }
    candles.setData(bars.map((b) => candlePoint(b, kind, dpThrRef.current)))
    try {
      chart.priceScale('right').applyOptions({ minimumWidth: 108, visible: true } as never)
      chart.panes()[0]?.priceScale('right').applyOptions({ minimumWidth: 108 } as never)
    } catch {
      /* ignore */
    }
    try {
      ;(chart.timeScale() as unknown as { applyOptions: (o: object) => void }).applyOptions({
        rightOffset: 8,
      })
    } catch {
      /* ignore */
    }
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

    histRef.current = {}
    for (const key of HIST_KEYS) {
      if (paneOnRef.current[key]) addHistPane(key)
    }

    try {
      stretchMainPane()
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
      const idhl = ctx.idhlByTime.get(t)
      const u = ctx.unit
      setTip({
        time: b.time_iso,
        ts: t,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: volOf(b, u),
        delta: deltaOf(b, u),
        delta_pct: b.delta_pct,
        cvd: ctx.cvdByTime.get(t),
        vwap: vp?.vwap,
        vwapBands: vwapBandList(vp, ctx.vwapBandMults),
        ma: ctx.showMa ? ctx.maByTime.get(t) : undefined,
        st: ctx.showStavp ? ctx.stByTime.get(t)?.value : undefined,
        stTrend: ctx.showStavp ? ctx.stByTime.get(t)?.trend : undefined,
        stavp: ctx.showStavp ? stavpVaFrom(ctx.stavpProfiles, t, u) : undefined,
        vaz: ctx.showVaz
          ? vazFromFlow(lookupVazBar(ctx.vazByTime, t, Math.max(1, tfRef.current) * 60), u)
          : undefined,
        idh: idhl?.idh,
        idl: idhl?.idl,
        minD: u === 'quote' ? f?.minDeltaQuote : f?.minDelta,
        maxD: u === 'quote' ? f?.maxDeltaQuote : f?.maxDelta,
        ch: u === 'quote' ? f?.cotHighQuote : f?.cotHigh,
        cl: u === 'quote' ? f?.cotLowQuote : f?.cotLow,
      })
    }
    chart.subscribeCrosshairMove(onMove as never)
    const onRange = () => {
      const r = chart.timeScale().getVisibleLogicalRange()
      if (r) {
        const prev = rangeRef.current
        rangeRef.current = { from: r.from, to: r.to }
        const xMoved =
          !prev || Math.abs(prev.from - r.from) > 0.15 || Math.abs(prev.to - r.to) > 0.15
        if (xMoved) fitPriceToCandles(chart, barsRef.current, r)
      }
      syncFlowStrip()
      syncAvpHandles()
      if (flowTimer.current != null) window.clearTimeout(flowTimer.current)
      flowTimer.current = window.setTimeout(loadFlowVisible, 350)
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    const onResize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w < 8 || h < 8) return
      chart.applyOptions({ width: w, height: h })
      chart.resize(w, h)
      try {
        ;(chart.timeScale() as unknown as { applyOptions: (o: object) => void }).applyOptions({
          rightOffset: 8,
        })
      } catch {
        /* ignore */
      }
      stretchMainPane()
      requestAnimationFrame(() => {
        stretchMainPane()
        clipPlotCanvases(el, chart)
        syncPaneOverlays()
      })
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
      fitPriceToCandles(chart, barsRef.current)
      requestAnimationFrame(syncPaneOverlays)
    })
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(() => onResize())
    ro.observe(el)
    if (wrapRef.current) ro.observe(wrapRef.current)
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
      candleDataRef.current = null
      maRef.current = null
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
    stretchMainPane()
    requestAnimationFrame(syncPaneOverlays)
  }, [visible])

  useEffect(() => {
    for (const key of HIST_KEYS) {
      histRef.current[key]?.series.setData(histData(key))
    }
    requestAnimationFrame(syncFlowStrip)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, unit, flow])

  useEffect(() => {
    loadFlowVisible()
    requestAnimationFrame(() => {
      syncAvpHandles()
      syncFlowStrip()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, symbol, tf, chartEpoch])

  useEffect(() => {
    syncAvpHandles()
  }, [vpT0, vpT1, showVp, chartEpoch])

  useEffect(() => {
    const ma = maRef.current
    if (!ma) return
    ma.applyOptions({ visible: showMa })
    ma.setData(showMa ? maSeries(bars, maPeriod, maType, maSrc) : [])
  }, [showMa, maPeriod, maType, maSrc, bars, chartEpoch])

  useEffect(() => {
    const s = candleDataRef.current
    if (s && bars.length) s.setData(bars.map((b) => candlePoint(b, kind, dpThr)))
    const h = histRef.current.dp
    const thr = Math.abs(Number(dpThr) || 50)
    if (h) h.series.setData(histData('dp'))
    if (h?.thrUp && h.thrDn) {
      h.thrUp.setData(bars.map((b) => ({ time: b.time, value: thr })))
      h.thrDn.setData(bars.map((b) => ({ time: b.time, value: -thr })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dpThr, bars, kind, chartEpoch])

  const vpInitedRef = useRef(false)
  useEffect(() => {
    if (!showVp) {
      vpInitedRef.current = false
      return
    }
    if (!bars.length || vpInitedRef.current) return
    vpInitedRef.current = true
    setVpT0(bars[Math.max(0, bars.length - 32)].time)
    setVpT1(bars[bars.length - 1].time)
  }, [showVp, bars])

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
    fitCandles()
  }
  const resetY = () => {
    fitCandles()
  }
  const end = () => {
    const ts = chartRef.current?.timeScale()
    if (!ts) return
    ts.scrollToRealTime()
    try {
      ;(ts as unknown as { applyOptions: (o: object) => void }).applyOptions({ rightOffset: 8 })
    } catch {
      /* ignore */
    }
    const r = ts.getVisibleLogicalRange()
    if (r) ts.setVisibleLogicalRange({ from: r.from, to: r.to + 8 })
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
        const anyHist = HIST_KEYS.some((key) => histRef.current[key])
        if (anyHist) {
          for (const key of HIST_KEYS) dropHistPane(key)
        } else {
          applyPaneVis()
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

  const paneLabel = (pl: PaneLayout, i: number) => {
    if (i === 0) return 'Price'
    const key = histKeyForPane(pl.id)
    return key ? HIST_LABEL[key] : `P${i + 1}`
  }
  const priceOnly = paneLayouts.length <= 1
  const bull = inspect ? inspect.close >= inspect.open : false
  const goldBar =
    inspect != null &&
    paneOn.dp &&
    Math.abs(inspect.delta_pct) >= Math.abs(dpThr || 0) &&
    Math.abs(dpThr || 0) > 0
  const pricePl = paneLayouts[0]
  const stripRows: { key: 'max' | 'min' | 'ch' | 'cl'; lab: string }[] = showBarStats
    ? (
        [
          barStatOn.max ? { key: 'max' as const, lab: 'MaxΔ' } : null,
          barStatOn.min ? { key: 'min' as const, lab: 'MinΔ' } : null,
          barStatOn.ch ? { key: 'ch' as const, lab: 'CH' } : null,
          barStatOn.cl ? { key: 'cl' as const, lab: 'CL' } : null,
        ] as const
      ).filter((x): x is { key: 'max' | 'min' | 'ch' | 'cl'; lab: string } => x != null)
    : []
  const stripH = stripRows.length * 16

  const startAvpDrag = (side: 'start' | 'end') => (e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault()
    e.stopPropagation()
    avpDragRef.current = side
    const move = (ev: globalThis.MouseEvent) => {
      const host = wrapRef.current
      if (!host || !avpDragRef.current) return
      const x = ev.clientX - host.getBoundingClientRect().left
      const t = xToBarTime(x)
      if (t == null) return
      if (avpDragRef.current === 'start') setVpT0(t)
      else setVpT1(t)
    }
    const up = () => {
      avpDragRef.current = null
      const a = vpRangeRef.current.t0
      const b = vpRangeRef.current.t1
      if (a != null && b != null && a > b) {
        setVpT0(b)
        setVpT1(a)
      }
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const useVisibleVp = () => {
    const chart = chartRef.current
    const r = chart?.timeScale().getVisibleLogicalRange()
    if (!r || !bars.length) return
    const from = Math.max(0, Math.floor(r.from))
    const to = Math.min(bars.length - 1, Math.ceil(r.to))
    setVpT0(bars[from].time)
    setVpT1(bars[to].time)
    vpPickRef.current = 'start'
  }

  const toggleStudiesPin = () => {
    if (studiesOpen || studiesPinned) {
      setStudiesPinned(false)
      setStudiesOpen(false)
    } else {
      setStudiesPinned(true)
      setStudiesOpen(true)
    }
  }

  const plotterText = (pl: PaneLayout, i: number): string | null => {
    if (!inspect) return null
    if (i === 0) return null
    const key = histKeyForPane(pl.id)
    if (!key || !paneOn[key]) return null
    if (key === 'vol') return `Vol ${fmtPlot(inspect.volume)}`
    if (key === 'delta') return `Δ ${fmtPlot(inspect.delta)}`
    if (key === 'dp') return `Δ% ${fmt2(inspect.delta_pct)}`
    if (key === 'cvd') return inspect.cvd != null ? `CVD ${fmtPlot(inspect.cvd)}` : 'CVD —'
    return null
  }

  const showTipStudies =
    paneOn.vol ||
    paneOn.delta ||
    paneOn.dp ||
    paneOn.cvd ||
    (showVwap && inspect?.vwap != null) ||
    (showMa && inspect?.ma != null) ||
    (showStavp && (inspect?.st != null || inspect?.stavp != null)) ||
    (showVaz && inspect?.vaz != null) ||
    (showIdhl && inspect?.idh != null)

  return (
    <div className="panel chart-panel of-chart" style={{ display: visible ? undefined : 'none' }}>
      <div className="chart-wrap" ref={wrapRef}>
        {inspect && (
          <div className={`of-inspector ${goldBar ? 'gold' : bull ? 'up' : 'dn'}${tipOpen ? '' : ' collapsed'}`}>
            <div className="tt-head">
              <div className="tt-time">{inspect.time.replace('T', ' ').slice(0, 19)} IST</div>
              <button
                type="button"
                className="tt-fold"
                title={tipOpen ? 'Hide values' : 'Show values'}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  setTipOpen((v) => !v)
                }}
              >
                {tipOpen ? '▾' : '▸'}
              </button>
            </div>
            {tipOpen && (
              <>
                <div className="tt-ohlc">
                  O {fmt2(inspect.open)} H {fmt2(inspect.high)} L {fmt2(inspect.low)} C {fmt2(inspect.close)}
                </div>
                {showTipStudies && (
                  <div className="tt-flow">
                    {showVwap && inspect.vwap != null && (
                      <div className="tt-row">
                        <span>
                          VWAP <b>{fmt2(inspect.vwap)}</b>
                        </span>
                        {inspect.vwapBands?.map((b) => (
                          <span key={b.mult}>
                            +{b.mult}σ <b>{fmt2(b.up)}</b>
                            {'  '}
                            −{b.mult}σ <b>{fmt2(b.dn)}</b>
                          </span>
                        ))}
                      </div>
                    )}
                    {showMa && inspect.ma != null && (
                      <div className="tt-row">
                        <span>
                          {maType.toUpperCase()} {maPeriod} <b>{fmt2(inspect.ma)}</b>
                        </span>
                      </div>
                    )}
                    {showStavp && inspect.st != null && (
                      <div className="tt-row">
                        <span>
                          ST {stPeriodSafe}/{stMultSafe}{' '}
                          <b className={inspect.stTrend === 1 ? 'tt-vah' : 'tt-val'}>{fmt2(inspect.st)}</b>
                          {inspect.stTrend === 1 ? ' up' : inspect.stTrend === -1 ? ' dn' : ''}
                        </span>
                      </div>
                    )}
                    {showStavp && inspect.stavp && (
                      <div className="tt-row">
                        <span>
                          STAVP VAH <b className="tt-vah">{fmt2(inspect.stavp.vah)}</b>
                        </span>
                        <span>
                          POC <b className="tt-poc">{fmt2(inspect.stavp.poc)}</b>
                        </span>
                        <span>
                          VAL <b className="tt-val">{fmt2(inspect.stavp.val)}</b>
                        </span>
                      </div>
                    )}
                    {showVaz && inspect.vaz && (
                      <div className="tt-row">
                        <span>
                          VAH <b className="tt-vah">{fmt2(inspect.vaz.vah)}</b>
                        </span>
                        <span>
                          POC <b className="tt-poc">{fmt2(inspect.vaz.poc)}</b>
                        </span>
                        <span>
                          VAL <b className="tt-val">{fmt2(inspect.vaz.val)}</b>
                        </span>
                      </div>
                    )}
                    {showIdhl && inspect.idh != null && inspect.idl != null && (
                      <div className="tt-row">
                        <span>
                          IDH <b className="tt-idh">{fmt2(inspect.idh)}</b>
                        </span>
                        <span>
                          IDL <b className="tt-idl">{fmt2(inspect.idl)}</b>
                        </span>
                      </div>
                    )}
                    {paneOn.vol && (
                      <div className="tt-row">
                        <span>
                          Vol <b>{fmtPlot(inspect.volume)}</b>
                        </span>
                      </div>
                    )}
                    {paneOn.delta && (
                      <div className="tt-row">
                        <span>
                          Δ <b className={clsSigned(inspect.delta)}>{fmtPlot(inspect.delta)}</b>
                        </span>
                      </div>
                    )}
                    {paneOn.dp && (
                      <div className="tt-row">
                        <span>
                          Δ% <b className={goldBar ? 'anom-ch' : clsSigned(inspect.delta_pct)}>{fmt2(inspect.delta_pct)}</b>
                        </span>
                      </div>
                    )}
                    {paneOn.cvd && inspect.cvd != null && (
                      <div className="tt-row">
                        <span>
                          CVD <b className={clsSigned(inspect.cvd)}>{fmtPlot(inspect.cvd)}</b>
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {showBarStats && (
                  <div className="of-bar-stats">
                    <div className="of-bar-stats-lab">Bar Statistics</div>
                    <div className="tt-flow">
                      {barStatOn.max && (
                        <div className="tt-row">
                          <span>
                            MaxΔ <b className={statCls('max', inspect.maxD)}>{inspect.maxD == null ? '—' : fmtPlot(inspect.maxD)}</b>
                          </span>
                        </div>
                      )}
                      {barStatOn.min && (
                        <div className="tt-row">
                          <span>
                            MinΔ <b className={statCls('min', inspect.minD)}>{inspect.minD == null ? '—' : fmtPlot(inspect.minD)}</b>
                          </span>
                        </div>
                      )}
                      {barStatOn.ch && (
                        <div className="tt-row">
                          <span>
                            CH <b className={statCls('ch', inspect.ch)}>{inspect.ch == null ? '—' : fmtPlot(inspect.ch)}</b>
                          </span>
                        </div>
                      )}
                      {barStatOn.cl && (
                        <div className="tt-row">
                          <span>
                            CL <b className={statCls('cl', inspect.cl)}>{inspect.cl == null ? '—' : fmtPlot(inspect.cl)}</b>
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
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
          showCot={false}
          showMinMax={false}
          showVp={showVp}
          vpMode={vpMode}
          vpBinMult={vpBinSafe}
          vazBinMult={vazBinSafe}
          vpT0={vpT0 != null && vpT1 != null ? Math.min(vpT0, vpT1) : vpT0}
          vpT1={vpT0 != null && vpT1 != null ? Math.max(vpT0, vpT1) : vpT1}
          showStavp={showStavp}
          stavpMode={stavpMode}
          stavpBinMult={stavpBinSafe}
          stavpWidthPct={stavpWidthSafe}
          stavpPlace={stavpPlace}
          stavpLegs={stavpCalc.legs}
          stavpPoints={stavpCalc.points}
          onStavpProfiles={setStavpProfiles}
          showIdhl={showIdhl}
          guides={guides}
          ofBars={ofSignalBars}
          showImb={showImb}
          showDiv={showDiv}
          showAbsorb={showAbsorb}
          absorbMode={absorbMode}
          absorbBodyPct={absorbBodyPct}
          showUa={showUa}
          showBigVol={showBigVol}
          showBigAsk={showBigAsk}
          showBigBid={showBigBid}
          imbRatio={imbRatio}
          imbConsec={imbConsec}
          imbIgnoreZero={imbIgnoreZero}
          imbMode={imbMode}
          bigMult={bigMult}
          symbol={symbol}
          tf={tf}
          unit={unit}
          mode={fpMode}
          binMult={binSafe}
          barTimes={barTimes}
          onVazBars={(next) => {
            const sig = next
              .map((b) => `${b.time}:${b.vah}:${b.val}:${b.poc}`)
              .join('|')
            if (sig === vazSigRef.current) return
            vazSigRef.current = sig
            setVazBars(next)
          }}
        />
        {paneLayouts.map((pl, i) =>
          pl.height < 20 ? null : (
            <div key={pl.id} className="pane-chrome" style={{ top: pl.top + 4, height: Math.max(0, pl.height - 8) }}>
              <span className="pane-chrome-lbl">{paneLabel(pl, i)}</span>
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
          const txt = plotterText(pl, i)
          if (!txt || pl.height < 20) return null
          return (
            <div key={`pl${pl.id}`} className="of-plotter" style={{ top: pl.top + 6 }}>
              {txt}
            </div>
          )
        })}
        {showVp && avpX.x0 != null && (
          <button
            type="button"
            className="avp-handle start"
            style={{ left: avpX.x0 }}
            title="Drag AVP start"
            onMouseDown={startAvpDrag('start')}
          />
        )}
        {showVp && avpX.x1 != null && (
          <button
            type="button"
            className="avp-handle end"
            style={{ left: avpX.x1 }}
            title="Drag AVP end"
            onMouseDown={startAvpDrag('end')}
          />
        )}
        {pricePl && stripCells.length > 0 && (
          <div
            className="of-flow-strip"
            style={{
              top: pricePl.top + Math.max(4, pricePl.height - stripH - 20),
              height: stripH,
            }}
          >
            {stripRows.map((row) => (
              <div key={row.key} className="of-flow-strip-row">
                <span className="of-flow-strip-lab">{row.lab}</span>
                {stripCells.map((c) => {
                  const v =
                    row.key === 'max' ? c.maxD : row.key === 'min' ? c.minD : row.key === 'ch' ? c.ch : c.cl
                  return (
                    <span
                      key={`${row.key}-${c.time}`}
                      className={`of-flow-strip-cell ${stripAnom(row.key, v)}`}
                      style={{ left: c.x, width: Math.max(10, c.w - 1) }}
                    >
                      {v == null || !Number.isFinite(v) ? '—' : fmtPlot(v)}
                    </span>
                  )
                })}
              </div>
            ))}
          </div>
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
          <button type="button" className="nav-btn" title="End / last candle" onClick={end}>
            ⇥
          </button>
          <button type="button" className="nav-btn" title="Offset candles to the right" onClick={offsetRight}>
            →|
          </button>
        </div>
      </div>

      {studiesTabHost
        ? createPortal(
            <button
              type="button"
              className={`of-edge left studies-tab${studiesOpen || studiesPinned ? ' on' : ''}`}
              title={studiesOpen || studiesPinned ? 'Close studies menu' : 'Open studies menu'}
              onClick={toggleStudiesPin}
            >
              STUDIES
            </button>,
            studiesTabHost,
          )
        : (
            <button
              type="button"
              className={`of-edge left studies-tab${studiesOpen || studiesPinned ? ' on' : ''}`}
              title={studiesOpen || studiesPinned ? 'Close studies menu' : 'Open studies menu'}
              onClick={toggleStudiesPin}
            >
              STUDIES
            </button>
          )}
      {(() => {
        const drawer = (
        <aside className={`of-drawer studies${studiesOpen ? ' open' : ''}`}>
          <div className="of-drawer-head">
            <b>Studies</b>
            <button
              type="button"
              className={`ghost of-pin${studiesPinned ? ' on' : ''}`}
              title={studiesPinned ? 'Close studies menu' : 'Pin open'}
              onClick={toggleStudiesPin}
            >
              {studiesPinned ? '📌' : '📍'}
            </button>
          </div>
          <span className="of-drawer-lab">Chart style</span>
          <div className="unit-toggle wrap">
            {(['candle', 'bar', 'line'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={priceKind === k ? 'active' : 'ghost'}
                onClick={() => {
                  setPriceKind(k)
                  if (k !== 'candle') setShowFootprint(false)
                }}
              >
                {k === 'candle' ? 'Candle' : k === 'bar' ? 'Bar' : 'Line'}
              </button>
            ))}
          </div>

          <span className="of-drawer-lab">Footprint</span>
          <div className="of-fp-row">
            <label className={`ov-toggle ${showFootprint ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={showFootprint}
                onChange={(e) => {
                  setShowFootprint(e.target.checked)
                  if (e.target.checked) setPriceKind('candle')
                }}
              />
              Footprint
            </label>
            {showFootprint && (
              <label className="of-inline">
                Bin ×
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={fpBinMult}
                  onChange={(e) => setFpBinMult(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
            )}
          </div>
          {showFootprint && (
            <span className="vwap-settings-hint">
              {fmtTick(symbolTickSize(symbol))} × {binSafe} = {fmtTick(symbolTickSize(symbol) * binSafe)} · {unitLabel}
            </span>
          )}
          <span className="of-drawer-lab">Quote</span>
          <div className="unit-toggle wrap">
            <button type="button" className={unit === 'quote' ? 'active' : 'ghost'} onClick={() => setUnit('quote')}>
              USDT
            </button>
            <button type="button" className={unit === 'base' ? 'active' : 'ghost'} onClick={() => setUnit('base')}>
              BASE
            </button>
          </div>
          <span className="of-drawer-lab">Modes</span>
          <div className="unit-toggle wrap">
            {(['profile', 'bidask', 'delta', 'volume'] as const).map((m) => (
              <button key={m} type="button" className={fpMode === m ? 'active' : 'ghost'} onClick={() => setFpMode(m)}>
                {m === 'bidask' ? 'Bid/Ask' : m === 'volume' ? 'Vol' : m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>

          <span className="of-drawer-lab">Indicators</span>
          <div className="of-chip-grid">
            <label className={`ov-toggle ${showVwap ? 'on' : ''}`}>
              <input type="checkbox" checked={showVwap} onChange={(e) => setShowVwap(e.target.checked)} />
              VWAP
            </label>
            {showVwap && (
              <div className="of-chip-extra">
                <label className="of-inline" title="σ multipliers">
                  Bands
                  <input value={vwapBandsRaw} onChange={(e) => setVwapBandsRaw(e.target.value)} placeholder="1,2" />
                </label>
              </div>
            )}
            <label className={`ov-toggle ${showMa ? 'on' : ''}`}>
              <input type="checkbox" checked={showMa} onChange={(e) => setShowMa(e.target.checked)} />
              MA
            </label>
            {showMa && (
              <div className="of-chip-extra">
                <div className="of-set-row">
                  <div className="unit-toggle wrap">
                    {(['sma', 'ema'] as const).map((t) => (
                      <button key={t} type="button" className={maType === t ? 'active' : 'ghost'} onClick={() => setMaType(t)}>
                        {t.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <label className="of-inline">
                    Period
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={maPeriod}
                      onChange={(e) => setMaPeriod(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                    />
                  </label>
                </div>
              </div>
            )}
            <label className={`ov-toggle ${showVp ? 'on' : ''}`} title="Anchored volume profile — drag yellow handles">
              <input type="checkbox" checked={showVp} onChange={(e) => setShowVp(e.target.checked)} />
              AVP
            </label>
            {showVp && (
              <div className="of-chip-extra">
                <div className="of-set-row">
                  <span className="of-inline-lab">Bin</span>
                  <div className="unit-toggle wrap">
                    <button
                      type="button"
                      className={vpBinMode === 'default' ? 'active' : 'ghost'}
                      title="Use Footprint candlestick bin"
                      onClick={() => setVpBinMode('default')}
                    >
                      Default
                    </button>
                    <button
                      type="button"
                      className={vpBinMode === 'custom' ? 'active' : 'ghost'}
                      onClick={() => {
                        if (vpBinMode !== 'custom') setVpBinMult(binSafe)
                        setVpBinMode('custom')
                      }}
                    >
                      Custom
                    </button>
                  </div>
                  {vpBinMode === 'custom' && (
                    <label className="of-inline">
                      ×
                      <input
                        type="number"
                        min={1}
                        max={10000}
                        value={vpBinMult}
                        onChange={(e) => setVpBinMult(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </label>
                  )}
                </div>
                <span className="vwap-settings-hint">
                  {fmtTick(symbolTickSize(symbol))} × {vpBinSafe} = {fmtTick(symbolTickSize(symbol) * vpBinSafe)}
                </span>
                <div className="unit-toggle wrap">
                  {(['profile', 'bidask', 'delta', 'volume'] as const).map((m) => (
                    <button key={m} type="button" className={vpMode === m ? 'active' : 'ghost'} onClick={() => setVpMode(m)}>
                      {m === 'bidask' ? 'Bid/Ask' : m === 'volume' ? 'Vol' : m[0].toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
                <span className="vwap-settings-hint">
                  {vpT0 != null ? fmtIstShort(vpT0) : '—'} → {vpT1 != null ? fmtIstShort(vpT1) : '—'}
                </span>
                <div className="unit-toggle wrap">
                  <button type="button" className="ghost" onClick={useVisibleVp}>
                    Visible
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setVpT0(null)
                      setVpT1(null)
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
            <label
              className={`ov-toggle ${showStavp ? 'on' : ''}`}
              title="SuperTrend-anchored volume profile — developing VAH / POC / VAL per ST leg"
            >
              <input type="checkbox" checked={showStavp} onChange={(e) => setShowStavp(e.target.checked)} />
              STAVP
            </label>
            {showStavp && (
              <div className="of-chip-extra">
                <div className="of-set-row">
                  <label className="of-inline" title="ATR period">
                    Period
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={stPeriod}
                      onChange={(e) => setStPeriod(Math.max(1, Math.round(Number(e.target.value) || 10)))}
                    />
                  </label>
                  <label className="of-inline" title="ATR multiplier">
                    Mult
                    <input
                      type="number"
                      min={0.1}
                      max={20}
                      step={0.1}
                      value={stMult}
                      onChange={(e) => setStMult(Math.max(0.1, Number(e.target.value) || 3))}
                    />
                  </label>
                  <label className="of-inline" title="Histogram width as % of SuperTrend candles. Type a number, then click away.">
                    Width %
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={stavpWidthDraft}
                      onChange={(e) => setStavpWidthDraft(e.target.value)}
                      onBlur={() => {
                        const n = Math.round(Number(stavpWidthDraft))
                        const next = Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 50
                        setStavpWidthPct(next)
                        setStavpWidthDraft(String(next))
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      }}
                    />
                  </label>
                </div>
                <div className="of-set-row">
                  <span className="of-inline-lab">Anchor</span>
                  <div className="unit-toggle wrap">
                    <button
                      type="button"
                      className={stavpPlace === 'swings' ? 'active' : 'ghost'}
                      title="Histogram starts at the swing high/low anchor"
                      onClick={() => setStavpPlace('swings')}
                    >
                      Swings
                    </button>
                    <button
                      type="button"
                      className={stavpPlace === 'lastCandle' ? 'active' : 'ghost'}
                      title="Histogram ends at the last candle of the SuperTrend phase"
                      onClick={() => setStavpPlace('lastCandle')}
                    >
                      Last candle
                    </button>
                  </div>
                </div>
                <div className="of-set-row">
                  <span className="of-inline-lab">Bin</span>
                  <div className="unit-toggle wrap">
                    <button
                      type="button"
                      className={stavpBinMode === 'default' ? 'active' : 'ghost'}
                      title="Use Footprint candlestick bin"
                      onClick={() => setStavpBinMode('default')}
                    >
                      Default
                    </button>
                    <button
                      type="button"
                      className={stavpBinMode === 'custom' ? 'active' : 'ghost'}
                      onClick={() => {
                        if (stavpBinMode !== 'custom') setStavpBinMult(binSafe)
                        setStavpBinMode('custom')
                      }}
                    >
                      Custom
                    </button>
                  </div>
                  {stavpBinMode === 'custom' && (
                    <label className="of-inline">
                      ×
                      <input
                        type="number"
                        min={1}
                        max={10000}
                        value={stavpBinMult}
                        onChange={(e) => setStavpBinMult(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </label>
                  )}
                </div>
                <span className="vwap-settings-hint">
                  {fmtTick(symbolTickSize(symbol))} × {stavpBinSafe} = {fmtTick(symbolTickSize(symbol) * stavpBinSafe)} ·{' '}
                  {stavpWidthSafe}% · {stavpPlace === 'swings' ? 'from swing start' : 'at last candle'}
                </span>
                <div className="unit-toggle wrap">
                  {(['profile', 'bidask', 'delta', 'volume'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={stavpMode === m ? 'active' : 'ghost'}
                      onClick={() => setStavpMode(m)}
                    >
                      {m === 'bidask' ? 'Bid/Ask' : m === 'volume' ? 'Vol' : m[0].toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <label className={`ov-toggle ${showIdhl ? 'on' : ''}`} title="Intraday high / low (UTC session)">
              <input type="checkbox" checked={showIdhl} onChange={(e) => setShowIdhl(e.target.checked)} />
              IDH/IDL
            </label>
            <label className={`ov-toggle ${showVaz ? 'on' : ''}`} title="Per-bar value area (VAH / POC / VAL)">
              <input type="checkbox" checked={showVaz} onChange={(e) => setShowVaz(e.target.checked)} />
              VAZ
            </label>
            {showVaz && (
              <div className="of-chip-extra">
                <div className="of-set-row">
                  <span className="of-inline-lab">Bin</span>
                  <div className="unit-toggle wrap">
                    <button
                      type="button"
                      className={vazBinMode === 'default' ? 'active' : 'ghost'}
                      title="Use Footprint candlestick bin"
                      onClick={() => setVazBinMode('default')}
                    >
                      Default
                    </button>
                    <button
                      type="button"
                      className={vazBinMode === 'custom' ? 'active' : 'ghost'}
                      onClick={() => {
                        if (vazBinMode !== 'custom') setVazBinMult(binSafe)
                        setVazBinMode('custom')
                      }}
                    >
                      Custom
                    </button>
                  </div>
                  {vazBinMode === 'custom' && (
                    <label className="of-inline">
                      ×
                      <input
                        type="number"
                        min={1}
                        max={10000}
                        value={vazBinMult}
                        onChange={(e) => setVazBinMult(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </label>
                  )}
                </div>
                <span className="vwap-settings-hint">
                  {fmtTick(symbolTickSize(symbol))} × {vazBinSafe} = {fmtTick(symbolTickSize(symbol) * vazBinSafe)}
                </span>
              </div>
            )}
            <label className={`ov-toggle ${showBarStats ? 'on' : ''}`} title="Bar statistics overlay">
              <input type="checkbox" checked={showBarStats} onChange={(e) => setShowBarStats(e.target.checked)} />
              Stats
            </label>
            {showBarStats && (
              <div className="of-chip-extra">
                <div className="unit-toggle wrap">
                  {(
                    [
                      ['ch', 'COT H'],
                      ['cl', 'COT L'],
                      ['min', 'MinΔ'],
                      ['max', 'MaxΔ'],
                    ] as const
                  ).map(([k, lab]) => (
                    <button
                      key={k}
                      type="button"
                      className={barStatOn[k] ? 'active' : 'ghost'}
                      onClick={() => setBarStatOn((p) => ({ ...p, [k]: !p[k] }))}
                    >
                      {lab}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {HIST_KEYS.map((key) => (
              <label key={key} className={`ov-toggle ${paneOn[key] ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={paneOn[key]}
                  onChange={(e) => setPaneOn((p) => ({ ...p, [key]: e.target.checked }))}
                />
                {key === 'vol' ? 'Vol' : key === 'delta' ? 'VolΔ' : key === 'dp' ? 'Δ%' : 'CVD'}
              </label>
            ))}
            {paneOn.dp && (
              <div className="of-chip-extra">
                <label className="of-inline" title="Gold bar when |Δ%| ≥ threshold">
                  Δ% thr
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={dpThr}
                    onChange={(e) => setDpThr(Math.max(0, Number(e.target.value) || 0))}
                  />
                </label>
              </div>
            )}
            <label className={`ov-toggle ${showImb ? 'on' : ''}`} title="Diagonal = ask vs bid one tick below">
              <input type="checkbox" checked={showImb} onChange={(e) => setShowImb(e.target.checked)} />
              Imb
            </label>
            {showImb && (
              <div className="of-chip-extra">
                <div className="of-set-row">
                  <label className="of-inline">
                    Ratio
                    <input
                      type="number"
                      min={1.5}
                      max={20}
                      step={0.5}
                      value={imbRatio}
                      onChange={(e) => setImbRatio(Math.max(1.5, Number(e.target.value) || 3))}
                    />
                  </label>
                  <label className="of-inline" title="Stacked same-side imbalances required">
                    Consec
                    <input
                      type="number"
                      min={1}
                      max={20}
                      step={1}
                      value={imbConsec}
                      onChange={(e) => setImbConsec(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                    />
                  </label>
                </div>
                <div className="of-set-row">
                  <label className={`ov-toggle ${imbIgnoreZero ? 'on' : ''}`} title="Skip pairs where bid or ask is 0">
                    <input
                      type="checkbox"
                      checked={imbIgnoreZero}
                      onChange={(e) => setImbIgnoreZero(e.target.checked)}
                    />
                    Ignore 0
                  </label>
                  <div className="unit-toggle wrap">
                    <button
                      type="button"
                      className={imbMode === 'diagonal' ? 'active' : 'ghost'}
                      onClick={() => setImbMode('diagonal')}
                    >
                      Diag
                    </button>
                    <button
                      type="button"
                      className={imbMode === 'horizontal' ? 'active' : 'ghost'}
                      onClick={() => setImbMode('horizontal')}
                    >
                      Horiz
                    </button>
                  </div>
                </div>
              </div>
            )}
            <label className={`ov-toggle ${showDiv ? 'on' : ''}`}>
              <input type="checkbox" checked={showDiv} onChange={(e) => setShowDiv(e.target.checked)} />
              Δ Div
            </label>
            <label className={`ov-toggle ${showAbsorb ? 'on' : ''}`}>
              <input type="checkbox" checked={showAbsorb} onChange={(e) => setShowAbsorb(e.target.checked)} />
              Absorb
            </label>
            {showAbsorb && (
              <div className="of-chip-extra">
                <div className="of-set-row">
                  <div className="unit-toggle wrap">
                    <button
                      type="button"
                      className={absorbMode === 'body' ? 'active' : 'ghost'}
                      title="|close−open| / (high−low) below Body %"
                      onClick={() => setAbsorbMode('body')}
                    >
                      Body
                    </button>
                    <button
                      type="button"
                      className={absorbMode === 'range' ? 'active' : 'ghost'}
                      title="high−low ≤ BB(20, 1) of prior ranges"
                      onClick={() => setAbsorbMode('range')}
                    >
                      Range
                    </button>
                    <button
                      type="button"
                      className={absorbMode === 'extreme' ? 'active' : 'ghost'}
                      title="Wick absorption: lower wick + sell delta + close>open, or upper wick + buy delta + close<open. Bubble at the wick price."
                      onClick={() => setAbsorbMode('extreme')}
                    >
                      Extreme
                    </button>
                  </div>
                  {absorbMode === 'body' && (
                    <label className="of-inline" title="Small body: |C−O| / (H−L) < this %">
                      Body %
                      <input
                        type="number"
                        min={5}
                        max={90}
                        step={1}
                        value={absorbBodyPct}
                        onChange={(e) => setAbsorbBodyPct(Math.max(5, Math.min(90, Number(e.target.value) || 35)))}
                      />
                    </label>
                  )}
                  <label
                    className="of-inline"
                    title={
                      absorbMode === 'extreme'
                        ? 'Wick volume (or bar volume) > mean + σ×this (20)'
                        : 'Volume > mean + σ×this (20). Body/Range also need HH or LL.'
                    }
                  >
                    σ ×
                    <input
                      type="number"
                      min={0.5}
                      max={10}
                      step={0.1}
                      value={bigMult}
                      onChange={(e) => setBigMult(Math.max(0.5, Number(e.target.value) || 1))}
                    />
                  </label>
                </div>
              </div>
            )}
            <label className={`ov-toggle ${showUa ? 'on' : ''}`} title="No ask at high / no bid at low — zoom in">
              <input type="checkbox" checked={showUa} onChange={(e) => setShowUa(e.target.checked)} />
              UA
            </label>
            <label className={`ov-toggle ${showBigVol ? 'on' : ''}`}>
              <input type="checkbox" checked={showBigVol} onChange={(e) => setShowBigVol(e.target.checked)} />
              BigVol
            </label>
            <label className={`ov-toggle ${showBigAsk ? 'on' : ''}`}>
              <input type="checkbox" checked={showBigAsk} onChange={(e) => setShowBigAsk(e.target.checked)} />
              BigAsk
            </label>
            <label className={`ov-toggle ${showBigBid ? 'on' : ''}`}>
              <input type="checkbox" checked={showBigBid} onChange={(e) => setShowBigBid(e.target.checked)} />
              BigBid
            </label>
            {(showBigVol || showBigAsk || showBigBid) && !showAbsorb && (
              <div className="of-chip-extra">
                <label className="of-inline" title="Fires when value > 20-bar mean + σ × this">
                  σ ×
                  <input
                    type="number"
                    min={0.5}
                    max={10}
                    step={0.1}
                    value={bigMult}
                    onChange={(e) => setBigMult(Math.max(0.5, Number(e.target.value) || 1))}
                  />
                </label>
              </div>
            )}
          </div>
        </aside>
        )
        return studiesDrawerHost ? createPortal(drawer, studiesDrawerHost) : drawer
      })()}
    </div>
  )
}
