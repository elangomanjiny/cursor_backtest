import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { OptimizePoint, OptimizeResult, StrategyParams, SystemResources } from '../api'
import { fetchSystemResources } from '../api'
import { fmt2, fmtCost, fmtPct } from '../format'
import {
  downloadComboDetailCsv,
  matchColumnFilter,
  visibleOptimizeColumns,
} from '../metricsCatalog'
import { SortTh, useSortable } from '../useSortable'
import { OptimizeHeatmap } from '../dashboard/OptimizeHeatmap'
import { MiniEquityChart } from '../dashboard/MiniEquityChart'
import { comboKey, flagOverfitRisk } from '../dashboard/overfitHeuristic'
import { GreenSwitch } from '../components/GreenSwitch'
import { countRange, countSweep, expandNumRange, expandSweep, type SweepNum } from '../optRange'

type DistUnit = 'range' | 'tick' | 'points' | 'pct'

function asOptUnit(raw: unknown, fallback: DistUnit = 'range'): DistUnit {
  return raw === 'tick' || raw === 'points' || raw === 'pct' || raw === 'range' ? raw : fallback
}

function expandCompact(p: SweepNum): string {
  if (Number(p.max) > Number(p.min) && Number(p.step) > 0) return expandNumRange(p)
  return String(p.def)
}

function countCompact(p: SweepNum): number {
  if (Number(p.max) > Number(p.min) && Number(p.step) > 0) return countRange(p)
  return 1
}

function SweepRow({
  label,
  title,
  value,
  onChange,
  stepHint = '1',
}: {
  label: string
  title?: string
  value: SweepNum
  onChange: (r: SweepNum) => void
  stepHint?: string
}) {
  const set = (patch: Partial<SweepNum>) => onChange({ ...value, ...patch })
  return (
    <div className={`opt-compact-row${value.on ? '' : ' opt-range-off'}`} title={title}>
      <span className="opt-range-lab">{label}</span>
      <GreenSwitch on={value.on} onChange={(on) => set({ on })} title="Sweep min·max·step" />
      <span className="opt-mode-slot" />
      <input
        className="num-plain"
        type="number"
        step={stepHint}
        value={value.def}
        disabled={value.on}
        onChange={(e) => set({ def: Number(e.target.value) })}
        aria-label={`${label} default`}
      />
      <input
        className="num-plain"
        type="number"
        step={stepHint}
        value={value.min}
        disabled={!value.on}
        onChange={(e) => set({ min: Number(e.target.value) })}
        aria-label={`${label} min`}
      />
      <input
        className="num-plain"
        type="number"
        step={stepHint}
        value={value.max}
        disabled={!value.on}
        onChange={(e) => set({ max: Number(e.target.value) })}
        aria-label={`${label} max`}
      />
      <input
        className="num-plain"
        type="number"
        step={stepHint}
        value={value.step}
        disabled={!value.on}
        onChange={(e) => set({ step: Number(e.target.value) })}
        aria-label={`${label} step`}
      />
    </div>
  )
}

function CompactNums({
  value,
  onChange,
  stepHint,
}: {
  value: SweepNum
  onChange: (r: SweepNum) => void
  stepHint: string
}) {
  const set = (patch: Partial<SweepNum>) => onChange({ ...value, ...patch })
  const sweeping = Number(value.max) > Number(value.min) && Number(value.step) > 0
  return (
    <>
      <input
        className="num-plain"
        type="number"
        step={stepHint}
        value={value.def}
        disabled={sweeping}
        onChange={(e) => set({ def: Number(e.target.value) })}
        aria-label="default"
      />
      <input
        className="num-plain"
        type="number"
        step={stepHint}
        value={value.min}
        onChange={(e) => set({ on: true, min: Number(e.target.value) })}
        aria-label="min"
      />
      <input
        className="num-plain"
        type="number"
        step={stepHint}
        value={value.max}
        onChange={(e) => set({ on: true, max: Number(e.target.value) })}
        aria-label="max"
      />
      <input
        className="num-plain"
        type="number"
        step={stepHint}
        value={value.step}
        onChange={(e) => set({ on: true, step: Number(e.target.value) })}
        aria-label="step"
      />
    </>
  )
}

function UnitSelect({
  value,
  onChange,
  rangeLabel,
}: {
  value: DistUnit
  onChange: (u: DistUnit) => void
  rangeLabel: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(asOptUnit(e.target.value, value))}
      aria-label="mode"
    >
      <option value="range">{rangeLabel}</option>
      <option value="tick">Tick</option>
      <option value="points">Points</option>
      <option value="pct">%</option>
    </select>
  )
}

function strategyToken(p: {
  wait_and_trade?: boolean
  pro_mode?: boolean
  pro_mtf_mode?: boolean
}): string {
  if (p.pro_mtf_mode) return 'pro_mtf'
  if (p.pro_mode) return 'pro'
  if (p.wait_and_trade) return 'true'
  return 'false'
}

export type OptimizeGrid = {
  tf: number
  thresholds: string
  rrs: string
  wait_flags: string
  re_entry_flags: string
  stop_to_be_flags: string
  break_even_flags: string
  break_even_pcts: string
  sl_tp_unit: DistUnit
  sl_unit: DistUnit
  tp_unit: DistUnit
  stop_losses: string
  take_profits: string
  trail_stop_flags: string
  risk_on_flags: string
  sl_on_flags: string
  tp_on_flags: string
  trail_unit: 'range' | 'tick' | 'points' | 'pct'
  trail_value: number
  trail_values: string
  be_unit: 'range' | 'tick' | 'points' | 'pct'
  be_value: number
  be_values: string
  be_ctc: number
  symbol: string
  start: string
  end: string
  /** Position size (lots). Comma list when sweeping. */
  volumes: string
  rank_by: string
  common_optimizer: boolean
  time_optimizer: boolean
  time_step_minutes: number
  timewindow: string
  dayofweek: string
  entry_after: number
  entry_before: number
  exit_time: number
  entry_after_to: number
  entry_before_to: number
  exit_time_to: number
  slippage_pcts: string
  fee_pcts: string
  min_trades: number
  time_stop_minutes: number
  /** Pro VWAP ±Nσ list (1,2,3) when Strategy includes Pro. Whole candle above +Nσ or below −Nσ. */
  pro_vwap_sigma: number
  pro_vwap_sigmas: string
  /** Pro-MTF base timeframe minutes (comma list). */
  base_tfs: string
  /** Pro-MTF base AGGR threshold % (comma list). */
  base_thresholds: string
  /** 0 = auto (CPU-1, capped at 4) */
  workers: number
}

const TF_OPTS = [1, 3, 5, 15, 30, 60] as const
const SYMBOL_OPTS = ['ETHUSDT', 'BTCUSDT'] as const

type Props = {
  result: OptimizeResult | null
  busy: boolean
  dataReady: boolean
  progress?: { done: number; total: number; workers?: number } | null
  defaultTf?: number
  defaultEntryAfter?: number
  defaultEntryBefore?: number
  defaultExitTime?: number
  defaultSlip?: number
  defaultFee?: number
  defaults?: Partial<StrategyParams>
  onRun: (grid: OptimizeGrid) => void
  onStop?: () => void
  onApplyBest: () => void
  onLoadCombo?: (
    point: OptimizePoint,
    viewFilter?: { dayofweek?: string; allowed_entry_hours?: string },
  ) => void
}

type SubTab = 'config' | 'heatmap' | 'leaderboard'

const RANK_OPTIONS = [
  ['sharpe', 'Sharpe'],
  ['sortino', 'Sortino'],
  ['sqn', 'SQN'],
  ['net_pnl', 'Net PnL'],
  ['profit_factor', 'Profit factor'],
  ['e_ratio', 'E-ratio'],
  ['calmar', 'Calmar'],
  ['expectancy', 'Expectancy'],
  ['win_rate', 'Win rate'],
  ['max_drawdown', 'Max DD (lower)'],
  ['avg_mfe', 'Avg MFE'],
]

const DOW = [
  ['mon', 'Mon'],
  ['tue', 'Tue'],
  ['wed', 'Wed'],
  ['thu', 'Thu'],
  ['fri', 'Fri'],
  ['sat', 'Sat'],
  ['sun', 'Sun'],
] as const

function minsToTime(m: number): string {
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function timeToMins(v: string): number {
  const [hh, mm] = v.split(':').map(Number)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0
  return hh * 60 + mm
}

function daysToStr(days: Set<string>): string {
  return DOW.map(([k]) => k).filter((k) => days.has(k)).join(',')
}

function istHour(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  return Number(parts.find((p) => p.type === 'hour')?.value || 0)
}

function istDow(iso: string): string {
  const w = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
  }).format(new Date(iso))
  return w.slice(0, 3).toLowerCase()
}

type BestTradeLite = { entry_time: string; pnl: number; side?: string; exit_reason?: string }

function summarizeTrades(trades: BestTradeLite[]) {
  const n = trades.length
  const wins = trades.filter((t) => t.pnl > 0).length
  const net = trades.reduce((s, t) => s + t.pnl, 0)
  const hours: Record<string, number> = {}
  for (const t of trades) {
    const h = String(istHour(t.entry_time))
    hours[h] = (hours[h] || 0) + 1
  }
  return {
    trades: n,
    net_pnl: net,
    win_rate: n ? (100 * wins) / n : 0,
    entry_hours: hours,
  }
}

function robustnessScore(r: Record<string, unknown>, overfit: boolean): number {
  const sharpe = Number(r.sharpe ?? 0)
  const n = Number(r.trades ?? 0)
  const dd = Math.abs(Number(r.max_drawdown ?? 0))
  const pf = Number(r.profit_factor ?? 0)
  let s = 50
  s += Math.max(-20, Math.min(25, sharpe * 8))
  s += Math.max(0, Math.min(15, Math.log10(Math.max(n, 1)) * 8))
  s -= Math.min(25, dd > 100 ? dd / 50 : dd)
  s += Math.max(-10, Math.min(10, (pf - 1) * 5))
  if (overfit) s -= 25
  if (Number(r.net_pnl ?? 0) <= 0) s -= 10
  return Math.max(0, Math.min(100, Math.round(s)))
}

export function OptimizeTab({
  result,
  busy,
  dataReady,
  progress,
  defaultTf = 15,
  defaultEntryAfter = 330,
  defaultEntryBefore = 1260,
  defaultExitTime = 1260,
  defaultSlip = 0.005,
  defaultFee = 0.05,
  defaults,
  onRun,
  onStop,
  onApplyBest,
  onLoadCombo,
}: Props) {
  const [subTab, setSubTab] = useState<SubTab>('config')
  const [tf, setTf] = useState(defaultTf)
  const [optSymbol, setOptSymbol] = useState(
    String(defaults?.symbol || 'ETHUSDT').toUpperCase(),
  )
  const [optStart, setOptStart] = useState(String(defaults?.start || '2026-08-01'))
  const [optEnd, setOptEnd] = useState(String(defaults?.end || '2026-08-03'))
  const dThr = Number(defaults?.threshold ?? 50)
  const dRr = Number(defaults?.rr ?? 1)
  const dSl = Number(defaults?.stop_loss ?? 50)
  const dTp = Number(defaults?.take_profit ?? 100)
  const dBaseTf = Number(defaults?.base_tf ?? 15)
  const dBaseThr = Number(defaults?.base_threshold ?? 30)
  const dSlip = Number(defaults?.slippage_pct ?? defaultSlip)
  const dFee = Number(defaults?.fee_pct ?? defaultFee)
  const dVol = Number(defaults?.volume ?? 0.01)
  const [thrRange, setThrRange] = useState<SweepNum>({
    on: true,
    def: dThr,
    min: 40,
    max: 60,
    step: 10,
  })
  const [rrRange, setRrRange] = useState<SweepNum>({
    on: true,
    def: dRr,
    min: 0.5,
    max: 2,
    step: 0.5,
  })
  const [slRange, setSlRange] = useState<SweepNum>({
    on: false,
    def: dSl,
    min: 30,
    max: 50,
    step: 10,
  })
  const [tpRange, setTpRange] = useState<SweepNum>({
    on: false,
    def: dTp,
    min: 60,
    max: 100,
    step: 20,
  })
  const [slipRange, setSlipRange] = useState<SweepNum>({
    on: false,
    def: dSlip,
    min: 0,
    max: dSlip > 0 ? dSlip : 0.01,
    step: dSlip > 0 ? dSlip : 0.01,
  })
  const [feeRange, setFeeRange] = useState<SweepNum>({
    on: false,
    def: dFee,
    min: 0,
    max: dFee > 0 ? dFee : 0.01,
    step: dFee > 0 ? dFee : 0.01,
  })
  const [volRange, setVolRange] = useState<SweepNum>({
    on: false,
    def: dVol > 0 ? dVol : 0.01,
    min: dVol > 0 ? dVol : 0.01,
    max: dVol > 0 ? dVol : 0.01,
    step: 0.01,
  })
  const [baseTfRange, setBaseTfRange] = useState<SweepNum>({
    on: false,
    def: dBaseTf,
    min: 15,
    max: 60,
    step: 15,
  })
  const [baseThrRange, setBaseThrRange] = useState<SweepNum>({
    on: false,
    def: dBaseThr,
    min: 20,
    max: 40,
    step: 10,
  })
  const [slUnit, setSlUnit] = useState<DistUnit>(
    asOptUnit(defaults?.sl_unit ?? defaults?.sl_tp_unit),
  )
  const [tpUnit, setTpUnit] = useState<DistUnit>(
    asOptUnit(defaults?.tp_unit ?? defaults?.sl_tp_unit),
  )
  const [trailDefault, setTrailDefault] = useState(Boolean(defaults?.trail_stop))
  const [trailUnit, setTrailUnit] = useState<DistUnit>(asOptUnit(defaults?.trail_unit))
  const dTrail = Number(defaults?.trail_value ?? 50)
  const [trailRange, setTrailRange] = useState<SweepNum>({
    on: false,
    def: dTrail,
    min: 30,
    max: 50,
    step: 10,
  })
  const [slDefault, setSlDefault] = useState(
    Number(defaults?.sl_on ?? defaults?.risk_on ?? 1) !== 0,
  )
  const [tpDefault, setTpDefault] = useState(
    Number(defaults?.tp_on ?? defaults?.risk_on ?? 1) !== 0,
  )
  const [beUnit, setBeUnit] = useState<DistUnit>(asOptUnit(defaults?.be_unit))
  const dBe = Number(defaults?.be_value ?? 50)
  const [beRange, setBeRange] = useState<SweepNum>({
    on: false,
    def: dBe,
    min: 20,
    max: 50,
    step: 10,
  })
  const [beCtc, setBeCtc] = useState(2)
  const [stratSweep, setStratSweep] = useState(false)
  const [stratDefault, setStratDefault] = useState(strategyToken(defaults || {}))
  const [stratDir, setStratDir] = useState(strategyToken(defaults || {}) === 'false')
  const [stratNd, setStratNd] = useState(strategyToken(defaults || {}) === 'true')
  const [stratPro, setStratPro] = useState(strategyToken(defaults || {}) === 'pro')
  const [stratMtf, setStratMtf] = useState(strategyToken(defaults || {}) === 'pro_mtf')
  const [sigmaRange, setSigmaRange] = useState<SweepNum>({
    on: false,
    def: defaults?.pro_vwap_sigma === 1 || defaults?.pro_vwap_sigma === 3
      ? defaults.pro_vwap_sigma
      : 2,
    min: 1,
    max: 3,
    step: 1,
  })
  const [rankBy, setRankBy] = useState('sharpe')
  const [commonOn, setCommonOn] = useState(true)
  const [timeOptOn, setTimeOptOn] = useState(false)
  const [timeStep, setTimeStep] = useState<30 | 60>(30)
  const [days, setDays] = useState<Set<string>>(
    () => new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  )
  const [entryAfter, setEntryAfter] = useState(defaultEntryAfter)
  const [entryBefore, setEntryBefore] = useState(Math.min(defaultEntryBefore, 15 * 60))
  const [exitTime, setExitTime] = useState(Math.min(defaultExitTime, 15 * 60))
  const [beDefault, setBeDefault] = useState(Boolean(defaults?.break_even))
  const [workers, setWorkers] = useState(0)
  const [resources, setResources] = useState<SystemResources | null>(null)
  const [selectedComboKey, setSelectedComboKey] = useState<string | null>(null)
  /** Direct object so Heatmap overview tracks the clicked cell, not only rank #1 */
  const [selectedCombo, setSelectedCombo] = useState<OptimizePoint | null>(null)

  const lastGrid = useRef<OptimizeGrid | null>(null)
  const lastRunRef = useRef(false)
  const [filterDays, setFilterDays] = useState<Set<string>>(
    () => new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  )
  const [filterHours, setFilterHours] = useState<Set<number> | null>(null)

  const [colFilters, setColFilters] = useState<Record<string, string>>({})
  const [hourMode, setHourMode] = useState<'trades' | 'pnl' | 'cost'>('pnl')

  const waitFlags = useMemo(() => {
    if (!stratSweep) return stratDefault
    const parts: string[] = []
    if (stratDir) parts.push('false')
    if (stratNd) parts.push('true')
    if (stratPro) parts.push('pro')
    if (stratMtf) parts.push('pro_mtf')
    return parts.join(',') || stratDefault
  }, [stratSweep, stratDefault, stratDir, stratNd, stratPro, stratMtf])

  const includesMtf = waitFlags.split(',').some((p) => {
    const t = p.trim().toLowerCase().replace('-', '_')
    return t === 'pro_mtf' || t === 'mtf' || t === 'pmtf'
  })
  const includesPro = waitFlags.split(',').some((p) => {
    const t = p.trim().toLowerCase()
    return t === 'pro' || t === 'p'
  })

  const breakEvenFlags = beDefault ? '1' : '0'
  const trailStopFlags = trailDefault ? '1' : '0'
  const slOnFlags = slDefault ? '1' : '0'
  const tpOnFlags = tpDefault ? '1' : '0'
  const slLive = slDefault
  const tpLive = tpDefault

  const stepMins = timeStep === 60 ? 60 : 30
  /** When Time opt is on: sweep entry-start from After … (Before − Step); Before & Flat stay fixed. */
  const entryAfterTo = useMemo(() => {
    if (!timeOptOn) return entryAfter
    return Math.max(entryAfter, entryBefore - stepMins)
  }, [timeOptOn, entryAfter, entryBefore, stepMins])

  const estSessions = useMemo(() => {
    if (!commonOn || !timeOptOn) return 1
    const n = Math.floor((entryAfterTo - entryAfter) / stepMins) + 1
    return Math.max(1, n)
  }, [commonOn, timeOptOn, entryAfter, entryAfterTo, stepMins])

  const estParamCombos = useMemo(() => {
    const nTh = countSweep(thrRange)
    const nSl = slLive && slUnit !== 'range' ? countCompact(slRange) : 1
    const nTp = tpLive && tpUnit !== 'range' ? countCompact(tpRange) : 1
    const nRr = tpLive && tpUnit === 'range' ? countCompact(rrRange) : 1
    const nSlip = countSweep(slipRange)
    const nFee = countSweep(feeRange)
    const nVol = countSweep(volRange)
    const nStrat = Math.max(1, waitFlags.split(',').filter(Boolean).length)
    const nBase =
      includesMtf ? countSweep(baseTfRange) * countSweep(baseThrRange) : 1
    const nSigma = includesPro ? countSweep(sigmaRange) : 1
    const nTrail = trailDefault && trailUnit !== 'range' ? countCompact(trailRange) : 1
    const nBe = beDefault && (beUnit === 'tick' || beUnit === 'points') ? countCompact(beRange) : 1
    return (
      nTh *
      nSl *
      nTp *
      nRr *
      nSlip *
      nFee *
      nVol *
      nStrat *
      nBase *
      nSigma *
      nTrail *
      nBe *
      estSessions
    )
  }, [
    thrRange,
    rrRange,
    slRange,
    tpRange,
    slUnit,
    tpUnit,
    slLive,
    tpLive,
    slipRange,
    feeRange,
    volRange,
    waitFlags,
    includesMtf,
    includesPro,
    baseTfRange,
    baseThrRange,
    sigmaRange,
    estSessions,
    trailDefault,
    trailUnit,
    trailRange,
    beDefault,
    beUnit,
    beRange,
  ])

  const buildGrid = (dayStr: string): OptimizeGrid => ({
    tf,
    thresholds: expandSweep(thrRange),
    rrs: tpLive && tpUnit === 'range' ? expandCompact(rrRange) : expandSweep(rrRange),
    wait_flags: waitFlags,
    re_entry_flags: '0',
    stop_to_be_flags: '0',
    break_even_flags: breakEvenFlags,
    break_even_pcts: '50',
    sl_tp_unit: slUnit,
    sl_unit: slUnit,
    tp_unit: tpUnit,
    stop_losses: slLive && slUnit !== 'range' ? expandCompact(slRange) : expandSweep(slRange),
    take_profits: tpLive && tpUnit !== 'range' ? expandCompact(tpRange) : expandSweep(tpRange),
    trail_stop_flags: trailStopFlags,
    risk_on_flags: slOnFlags.includes('1') || tpOnFlags.includes('1') ? '1' : '0',
    sl_on_flags: slOnFlags,
    tp_on_flags: tpOnFlags,
    trail_unit: trailUnit,
    trail_value: trailRange.def,
    trail_values:
      trailDefault && trailUnit !== 'range' ? expandCompact(trailRange) : String(trailRange.def),
    be_unit: beUnit,
    be_value: beRange.def,
    be_values:
      beDefault && (beUnit === 'tick' || beUnit === 'points')
        ? expandCompact(beRange)
        : String(beRange.def),
    be_ctc: Number.isFinite(beCtc) ? beCtc : 2,
    symbol: optSymbol,
    start: optStart,
    end: optEnd,
    volumes: expandSweep(volRange),
    rank_by: rankBy,
    common_optimizer: commonOn,
    time_optimizer: commonOn && timeOptOn,
    time_step_minutes: stepMins,
    timewindow: '',
    dayofweek: dayStr,
    entry_after: entryAfter,
    entry_before: entryBefore,
    exit_time: exitTime,
    entry_after_to: entryAfterTo,
    entry_before_to: entryBefore,
    exit_time_to: exitTime,
    slippage_pcts: expandSweep(slipRange),
    fee_pcts: expandSweep(feeRange),
    min_trades: 0,
    time_stop_minutes: 0,
    pro_vwap_sigma: sigmaRange.def,
    pro_vwap_sigmas: includesPro ? expandSweep(sigmaRange) : String(sigmaRange.def),
    base_tfs: includesMtf ? expandSweep(baseTfRange) : '',
    base_thresholds: includesMtf ? expandSweep(baseThrRange) : '',
    workers: Math.max(0, Math.floor(workers)),
  })

  useEffect(() => {
    if (!result) {
      setSelectedCombo(null)
      setSelectedComboKey(null)
      return
    }
    setFilterDays(new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))
    setFilterHours(null)
    setSelectedCombo(null)
    setSelectedComboKey(null)
  }, [result])

  useEffect(() => {
    if (!busy) {
      setResources(null)
      return
    }
    let alive = true
    const ac = new AbortController()
    const tick = async () => {
      try {
        const snap = await fetchSystemResources(ac.signal)
        if (alive) setResources(snap)
      } catch {
        /* ignore */
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), 1500)
    return () => {
      alive = false
      ac.abort()
      window.clearInterval(id)
    }
  }, [busy])

  useEffect(() => {
    if (!busy && result && lastRunRef.current) {
      lastRunRef.current = false
      setSubTab('heatmap')
    }
  }, [busy, result])

  const filteredBest = useMemo(() => {
    const raw = result?.best_trades
    if (!raw?.length) return null
    const hourSet = filterHours
    const trades = raw.filter((t) => {
      if (!filterDays.has(istDow(t.entry_time))) return false
      if (hourSet && !hourSet.has(istHour(t.entry_time))) return false
      return true
    })
    return { list: trades, ...summarizeTrades(trades) }
  }, [result?.best_trades, filterDays, filterHours])

  const heatmap =
    (selectedCombo?.entry_hours as Record<string, number> | undefined) ||
    filteredBest?.entry_hours ||
    result?.entry_hour_heatmap ||
    result?.best?.entry_hours ||
    null

  const hourBuckets = useMemo(() => {
    type B = { trades: number; pnl: number; cost: number }
    const out: Record<number, B> = {}
    for (let h = 0; h < 24; h++) out[h] = { trades: 0, pnl: 0, cost: 0 }

    const lite = selectedCombo?.trades_lite
    const fromLite = lite?.length
      ? lite
      : !selectedCombo && result?.best_trades?.length
        ? result.best_trades.map((t) => ({
            entry_time: t.entry_time,
            pnl: t.pnl,
            slippage: 0,
            fee: 0,
          }))
        : null

    if (fromLite) {
      for (const t of fromLite) {
        const et = String(t.entry_time || '')
        if (!et) continue
        if (!filterDays.has(istDow(et))) continue
        const h = istHour(et)
        if (filterHours && !filterHours.has(h)) continue
        out[h].trades += 1
        out[h].pnl += Number(t.pnl) || 0
        out[h].cost +=
          Number((t as { slippage?: number }).slippage || 0) +
          Number((t as { fee?: number }).fee || 0)
      }
      return out
    }

    for (let h = 0; h < 24; h++) {
      out[h].trades = Number(heatmap?.[String(h)] || 0)
    }
    return out
  }, [selectedCombo, result?.best_trades, filterDays, filterHours, heatmap])

  const hourMax = useMemo(() => {
    let m = 1e-9
    for (let h = 0; h < 24; h++) {
      const b = hourBuckets[h]
      const v =
        hourMode === 'trades' ? b.trades : hourMode === 'pnl' ? Math.abs(b.pnl) : b.cost
      if (v > m) m = v
    }
    return m
  }, [hourBuckets, hourMode])

  const optRows = useMemo(
    () =>
      (result?.results ?? []).map((r, i) => ({
        ...r,
        _rank: i,
        _strategy: Number(r.pro_mtf_mode)
          ? 'Pro-MTF'
          : r.pro_mode
            ? 'Pro'
            : r.wait_and_trade
              ? 'Non-Dir'
              : 'Dir',
        _be: Number(r.break_even) ? 'On' : 'Off',
        _bePct: Number(r.break_even) ? Number(r.break_even_pct ?? 50) : -1,
        _key: comboKey(r),
        _robust: 0,
      })),
    [result?.results],
  )

  const reportCols = useMemo(
    () => visibleOptimizeColumns(optRows as unknown as Record<string, unknown>[]),
    [optRows],
  )

  const overfitKeys = useMemo(
    () => flagOverfitRisk((result?.results ?? []) as OptimizePoint[]),
    [result?.results],
  )

  const optRowsScored = useMemo(
    () =>
      optRows.map((r) => ({
        ...r,
        _robust: robustnessScore(r as unknown as Record<string, unknown>, overfitKeys.has(r._key)),
      })),
    [optRows, overfitKeys],
  )

  const filterCellValue = useCallback(
    (r: (typeof optRowsScored)[number], key: string): unknown => {
      if (key === '_strategy' || key === 'strategy') return r._strategy
      if (key === '_be' || key === 'be') return r._be
      if (key === '_bePct' || key === 'break_even_pct') return r._bePct < 0 ? '' : r._bePct
      if (key === '_robust' || key === 'robustness') return r._robust
      if (key === 'after' || key === 'entry_after') return minsToTime(Number(r.entry_after ?? 0))
      if (key === 'before' || key === 'entry_before') return minsToTime(Number(r.entry_before ?? 0))
      if (key === 'flat' || key === 'exit_time') return minsToTime(Number(r.exit_time ?? 0))
      if (key === 'gross_pnl') {
        const rec = r as unknown as Record<string, unknown>
        if (rec.gross_pnl != null && rec.gross_pnl !== '') return Number(rec.gross_pnl)
        return Number(rec.net_pnl ?? 0) + Number(rec.total_fees ?? 0)
      }
      if (key === 'total_cost') {
        const rec = r as unknown as Record<string, unknown>
        if (rec.total_cost != null && rec.total_cost !== '') return Number(rec.total_cost)
        return Number(rec.total_slippage ?? 0) + Number(rec.total_fees ?? 0)
      }
      return (r as unknown as Record<string, unknown>)[key]
    },
    [],
  )

  const lbRows = useMemo(() => {
    const active = Object.entries(colFilters).filter(([, v]) => v.trim())
    if (!active.length) return optRowsScored
    return optRowsScored.filter((r) =>
      active.every(([key, f]) => matchColumnFilter(filterCellValue(r, key), f)),
    )
  }, [optRowsScored, colFilters, filterCellValue])

  const optGet = useCallback((row: (typeof optRowsScored)[number], key: string): unknown => {
    if (key === 'gross_pnl') {
      const rec = row as unknown as Record<string, unknown>
      if (rec.gross_pnl != null && rec.gross_pnl !== '') return Number(rec.gross_pnl)
      return Number(rec.net_pnl ?? 0) + Number(rec.total_fees ?? 0)
    }
    if (key === 'total_cost') {
      const rec = row as unknown as Record<string, unknown>
      if (rec.total_cost != null && rec.total_cost !== '') return Number(rec.total_cost)
      return Number(rec.total_slippage ?? 0) + Number(rec.total_fees ?? 0)
    }
    return (row as unknown as Record<string, unknown>)[key]
  }, [])

  const optSort = useSortable(lbRows, optGet, { key: '_rank', dir: 'asc' })

  /** Select for Heatmap inspection (does not leave Optimize). */
  const selectCombo = (point: OptimizePoint) => {
    setSelectedComboKey(comboKey(point))
    setSelectedCombo(point)
    setSubTab('heatmap')
  }

  /** Load into Backtest engine (switches to Backtest tab). */
  const applyCombo = (
    point: OptimizePoint,
    viewFilter?: { dayofweek?: string; allowed_entry_hours?: string },
  ) => {
    setSelectedComboKey(comboKey(point))
    setSelectedCombo(point)
    onLoadCombo?.(point, viewFilter)
  }

  const toggleDay = (key: string) => {
    setDays((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        if (next.size <= 1) return prev
        next.delete(key)
      } else next.add(key)
      return next
    })
  }

  const toggleFilterDay = (key: string) => {
    setFilterDays((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        if (next.size <= 1) return prev
        next.delete(key)
      } else next.add(key)
      return next
    })
  }

  const toggleFilterHour = (h: number) => {
    setFilterHours((prev) => {
      const base = prev ?? new Set(Array.from({ length: 24 }, (_, i) => i))
      const next = new Set(base)
      if (next.has(h)) {
        if (next.size <= 1) return next
        next.delete(h)
      } else next.add(h)
      if (next.size === 24) return null
      return next
    })
  }

  const downloadRowCsv = (r: (typeof optRowsScored)[number], e?: ReactMouseEvent) => {
    e?.stopPropagation()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const thr = fmt2(r.threshold).replace('.', 'p')
    const rr = fmt2(r.rr).replace('.', 'p')
    downloadComboDetailCsv(
      r as unknown as Record<string, unknown>,
      `optimize-combo-thr${thr}-rr${rr}-${stamp}.csv`,
    )
  }

  const run = () => {
    const dayStr = daysToStr(days)
    const grid = buildGrid(dayStr)
    lastGrid.current = grid
    lastRunRef.current = true
    onRun(grid)
  }

  const best = result?.best
  const showProgress = busy || Boolean(progress && progress.total > 0)

  const overview = selectedCombo ?? result?.best ?? null
  const overviewIsSelected = Boolean(selectedCombo)

  /** Hour/day filters for Selected Combo — show beside raw optimize metrics. */
  const filteredOverview = useMemo(() => {
    const lite = overview?.trades_lite
    if (!lite?.length) return null
    const hourSet = filterHours
    const trades = lite.filter((t) => {
      if (!filterDays.has(istDow(String(t.entry_time)))) return false
      if (hourSet && !hourSet.has(istHour(String(t.entry_time)))) return false
      return true
    })
    if (trades.length === lite.length && !hourSet) return null
    return summarizeTrades(
      trades.map((t) => ({
        entry_time: String(t.entry_time),
        pnl: Number(t.pnl) || 0,
      })),
    )
  }, [overview, filterDays, filterHours])

  const equitySpark = useMemo(() => {
    const lite =
      overview?.trades_lite ||
      (!selectedCombo && result?.best_trades
        ? result.best_trades.map((t) => ({
            entry_time: t.entry_time,
            pnl: Number(t.pnl) || 0,
            side: t.side,
            exit_reason: t.exit_reason,
          }))
        : null)
    if (lite?.length) {
      const hourSet = filterHours
      const trades = lite.filter((t) => {
        if (!filterDays.has(istDow(String(t.entry_time)))) return false
        if (hourSet && !hourSet.has(istHour(String(t.entry_time)))) return false
        return true
      })
      if (trades.length) {
        let eq = 0
        return trades.map((t) => {
          eq += Number(t.pnl) || 0
          return eq
        })
      }
    }
    if (overview && Array.isArray(overview.equity_spark) && overview.equity_spark.length) {
      return overview.equity_spark as number[]
    }
    return [] as number[]
  }, [overview, selectedCombo, result?.best_trades, filterDays, filterHours])

  const viewFilterForApply = useMemo(() => {
    const dayStr = daysToStr(filterDays)
    const allDays = filterDays.size >= 7
    const hours =
      filterHours && filterHours.size > 0
        ? [...filterHours].sort((a, b) => a - b).join(',')
        : undefined
    if (!hours && allDays) return undefined
    return {
      dayofweek: allDays ? undefined : dayStr,
      allowed_entry_hours: hours,
    }
  }, [filterDays, filterHours])

  const sparkMin = equitySpark.length ? Math.min(...equitySpark, 0) : 0
  const sparkMax = equitySpark.length ? Math.max(...equitySpark, 0) : 1
  const sparkRange = Math.max(1e-9, sparkMax - sparkMin)

  const vsBest = useMemo(() => {
    if (!overview || !best) return null
    if (comboKey(overview) === comboKey(best)) return null
    const d = (a: number, b: number) => a - b
    return {
      sharpe: d(Number(overview.sharpe ?? 0), Number(best.sharpe ?? 0)),
      net: d(Number(overview.net_pnl ?? 0), Number(best.net_pnl ?? 0)),
      pf: d(Number(overview.profit_factor ?? 0), Number(best.profit_factor ?? 0)),
      win: d(Number(overview.win_rate ?? 0), Number(best.win_rate ?? 0)),
      trades: d(Number(overview.trades ?? 0), Number(best.trades ?? 0)),
      dd: d(Number(overview.max_drawdown ?? 0), Number(best.max_drawdown ?? 0)),
      sqn: d(Number(overview.sqn ?? 0), Number(best.sqn ?? 0)),
    }
  }, [overview, best])

  const timeOptActive = Boolean(result?.time_optimizer)

  return (
    <div className="opt-shell">
      <nav className="opt-subnav">
        <button
          type="button"
          className={subTab === 'config' ? 'active' : ''}
          onClick={() => setSubTab('config')}
        >
          Settings
        </button>
        <button
          type="button"
          className={subTab === 'heatmap' ? 'active' : ''}
          onClick={() => setSubTab('heatmap')}
        >
          Analysis
        </button>
        <button
          type="button"
          className={subTab === 'leaderboard' ? 'active' : ''}
          onClick={() => setSubTab('leaderboard')}
        >
          Results
        </button>
      </nav>

      {showProgress && (
        <div
          className={`opt-progress compact ${
            resources?.warn_level === 'red'
              ? 'warn-red'
              : resources?.warn_level === 'amber'
                ? 'warn-amber'
                : ''
          }`}
        >
          <div className="opt-progress-meta">
            <span>
              {busy ? `${progress?.done ?? 0} / ${progress?.total || '…'}` : 'Done'}
            </span>
            <span>
              {progress && progress.total > 0
                ? `${Math.round((100 * progress.done) / progress.total)}%`
                : '—'}
            </span>
            {resources?.ram_percent != null && (
              <span>
                RAM {fmt2(resources.ram_percent)}%
                {resources.warn_level === 'red'
                  ? ' · Critical'
                  : resources.warn_level === 'amber'
                    ? ' · High'
                    : ''}
              </span>
            )}
            <span>w={progress?.workers ?? (workers || 'Auto')}</span>
          </div>
          <div className="opt-progress-track">
            <div
              className="opt-progress-fill"
              style={{
                width:
                  progress && progress.total > 0
                    ? `${Math.min(100, (100 * progress.done) / progress.total)}%`
                    : busy
                      ? '8%'
                      : '0%',
              }}
            />
          </div>
        </div>
      )}

      <div className="opt-subview">
        {subTab === 'config' && (
          <div className="opt-config-grid">
            <section className="opt-cfg-card">
              <h3>Parameter Grid Ranges</h3>
              <p className="opt-range-hint">
                Green switch = feature on (exits) or sweep Min·Max·Step (numeric). Off = default
                only. Est. ~{estParamCombos} combos before cap.
              </p>
              <div className="opt-compact-hdr" aria-hidden>
                <span>Param</span>
                <span>On</span>
                <span>Mode</span>
                <span>Def</span>
                <span>Min</span>
                <span>Max</span>
                <span>Step</span>
              </div>

              <h4 className="opt-cfg-cat">Exits</h4>
              <div
                className="opt-compact-row"
                title="Hard stop. Range uses AGGR high/low; otherwise Def·Min·Max·Step."
              >
                <span className="opt-range-lab">StopLoss</span>
                <GreenSwitch on={slDefault} onChange={setSlDefault} />
                {slDefault ? (
                  <UnitSelect value={slUnit} onChange={setSlUnit} rangeLabel="Range" />
                ) : (
                  <span className="opt-mode-slot" />
                )}
                {slDefault && slUnit !== 'range' ? (
                  <CompactNums
                    value={slRange}
                    onChange={setSlRange}
                    stepHint={slUnit === 'pct' ? '0.1' : '1'}
                  />
                ) : (
                  <>
                    <span />
                    <span />
                    <span />
                    <span />
                  </>
                )}
              </div>
              <div
                className="opt-compact-row"
                title="Take profit. Range = AGGR range × RR; otherwise Def·Min·Max·Step."
              >
                <span className="opt-range-lab">Target</span>
                <GreenSwitch on={tpDefault} onChange={setTpDefault} />
                {tpDefault ? (
                  <UnitSelect value={tpUnit} onChange={setTpUnit} rangeLabel="Range×RR" />
                ) : (
                  <span className="opt-mode-slot" />
                )}
                {tpDefault && tpUnit === 'range' ? (
                  <CompactNums value={rrRange} onChange={setRrRange} stepHint="0.1" />
                ) : tpDefault ? (
                  <CompactNums
                    value={tpRange}
                    onChange={setTpRange}
                    stepHint={tpUnit === 'pct' ? '0.1' : '1'}
                  />
                ) : (
                  <>
                    <span />
                    <span />
                    <span />
                    <span />
                  </>
                )}
              </div>
              <div className="opt-compact-row" title="Trailing stop, independent of SL/TP. Range uses AGGR gap; otherwise Def·Min·Max·Step.">
                <span className="opt-range-lab">Trail</span>
                <GreenSwitch on={trailDefault} onChange={setTrailDefault} />
                {trailDefault ? (
                  <UnitSelect value={trailUnit} onChange={setTrailUnit} rangeLabel="Range" />
                ) : (
                  <span className="opt-mode-slot" />
                )}
                {trailDefault && trailUnit !== 'range' ? (
                  <CompactNums
                    value={trailRange}
                    onChange={setTrailRange}
                    stepHint={trailUnit === 'pct' ? '0.01' : '1'}
                  />
                ) : (
                  <>
                    <span />
                    <span />
                    <span />
                    <span />
                  </>
                )}
              </div>
              <div className="opt-compact-row" title="BE target (arm). Tick/Points: Def·Min·Max·Step. After the arm, lock uses CTC (not swept).">
                <span className="opt-range-lab">BE</span>
                <GreenSwitch on={beDefault} onChange={setBeDefault} />
                {beDefault ? (
                  <UnitSelect value={beUnit} onChange={setBeUnit} rangeLabel="Range" />
                ) : (
                  <span className="opt-mode-slot" />
                )}
                {beDefault && (beUnit === 'tick' || beUnit === 'points') ? (
                  <CompactNums
                    value={beRange}
                    onChange={setBeRange}
                    stepHint="1"
                  />
                ) : (
                  <>
                    <span />
                    <span />
                    <span />
                    <span />
                  </>
                )}
              </div>
              {beDefault && (
                <div
                  className="opt-compact-row"
                  title="Cost-to-cover multiplier. Lock = (slip USDT + fee USDT) × CTC ÷ lots. Not swept."
                >
                  <span className="opt-range-lab">CTC</span>
                  <span />
                  <span className="opt-mode-slot" />
                  <input
                    className="num-plain"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.5"
                    value={beCtc}
                    onChange={(e) => setBeCtc(Number(e.target.value))}
                    onBlur={() => setBeCtc(Math.max(0, Number(beCtc) || 2))}
                    aria-label="CTC"
                  />
                  <span />
                  <span />
                  <span />
                </div>
              )}

              <h4 className="opt-cfg-cat">Strategy settings</h4>
              <SweepRow
                label="Thr"
                title="Delta threshold %"
                value={thrRange}
                onChange={setThrRange}
                stepHint="1"
              />
              <div className="opt-compact-row opt-strat-row">
                <span className="opt-range-lab">Strategy</span>
                <GreenSwitch
                  on={stratSweep}
                  onChange={setStratSweep}
                  title="Sweep multiple strategies"
                />
                <span className="opt-mode-slot opt-strat-slot">
                  {stratSweep ? (
                    <div className="be-opt-flags opt-strat-flags">
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={stratDir}
                          onChange={(e) => setStratDir(e.target.checked)}
                        />
                        Dir
                      </label>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={stratNd}
                          onChange={(e) => setStratNd(e.target.checked)}
                        />
                        Non-Dir
                      </label>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={stratPro}
                          onChange={(e) => setStratPro(e.target.checked)}
                        />
                        Pro
                      </label>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={stratMtf}
                          onChange={(e) => setStratMtf(e.target.checked)}
                        />
                        Pro-MTF
                      </label>
                    </div>
                  ) : (
                    <select
                      value={stratDefault}
                      onChange={(e) => setStratDefault(e.target.value)}
                      aria-label="Strategy default"
                    >
                      <option value="false">Directional</option>
                      <option value="true">Non-Directional</option>
                      <option value="pro">Pro</option>
                      <option value="pro_mtf">Pro-MTF</option>
                    </select>
                  )}
                </span>
              </div>
              {includesPro && (
                <SweepRow
                  label="Pro σ"
                  title="Pro: whole candle above VWAP+Nσ (low > +Nσ) or below VWAP−Nσ (high < −Nσ)"
                  value={sigmaRange}
                  onChange={setSigmaRange}
                  stepHint="1"
                />
              )}
              {includesMtf && (
                <>
                  <SweepRow
                    label="Base TF"
                    title="Pro-MTF higher timeframe (must be > chart TF)"
                    value={baseTfRange}
                    onChange={setBaseTfRange}
                    stepHint="15"
                  />
                  <SweepRow
                    label="Base Thr"
                    title="Pro-MTF HTF AGGR threshold %"
                    value={baseThrRange}
                    onChange={setBaseThrRange}
                    stepHint="5"
                  />
                </>
              )}

              <h4 className="opt-cfg-cat">Volume</h4>
              <SweepRow
                label="Vol"
                title="Position size in lots (ETHUSDT 0.01 = 0.01 ETH). Scales PnL, fees, and drawdown."
                value={volRange}
                onChange={setVolRange}
                stepHint="0.01"
              />

              <h4 className="opt-cfg-cat">Slippage &amp; fees</h4>
              <SweepRow
                label="Slip%"
                title="Both fills: long entry + / exit −, short opposite. Default 0.005 = 0.005%."
                value={slipRange}
                onChange={setSlipRange}
                stepHint="0.001"
              />
              <SweepRow
                label="Fee%"
                title="After slip, both legs: (entry+exit)×lots×Fee%/100 = 2×avg×lots×Fee%/100. Default 0.05."
                value={feeRange}
                onChange={setFeeRange}
                stepHint="0.001"
              />
            </section>

            <section className="opt-cfg-card">
              <h3>Time &amp; Session</h3>
              {!dataReady && <span className="opt-warn">Load data first</span>}
              <label title="Symbol for this optimize run (must already be loaded)">
                Symbol
                <select
                  value={optSymbol}
                  disabled={busy}
                  onChange={(e) => setOptSymbol(e.target.value.toUpperCase())}
                >
                  {!SYMBOL_OPTS.includes(optSymbol as (typeof SYMBOL_OPTS)[number]) && (
                    <option value={optSymbol}>{optSymbol}</option>
                  )}
                  {SYMBOL_OPTS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label title="Optimize start date (UTC, inclusive). Load this range in Step 1 first.">
                Start
                <input
                  type="date"
                  disabled={busy}
                  value={optStart}
                  onChange={(e) => setOptStart(e.target.value)}
                />
              </label>
              <label title="Optimize end date (UTC, exclusive). Load this range in Step 1 first.">
                End
                <input
                  type="date"
                  disabled={busy}
                  value={optEnd}
                  onChange={(e) => setOptEnd(e.target.value)}
                />
              </label>
              <label title="Bar timeframe for this optimize run (independent of Backtest TF)">
                TF
                <select
                  value={tf}
                  disabled={busy}
                  onChange={(e) => setTf(Number(e.target.value))}
                >
                  {TF_OPTS.map((m) => (
                    <option key={m} value={m}>
                      {m}m
                    </option>
                  ))}
                </select>
              </label>
              <label className="check opt-toggle">
                <input
                  type="checkbox"
                  checked={commonOn}
                  onChange={(e) => {
                    const on = e.target.checked
                    setCommonOn(on)
                    if (!on) setTimeOptOn(false)
                  }}
                />
                Common
              </label>
              <label className="check opt-toggle" title="Sweep entry-start (After) across the window by Step">
                <input
                  type="checkbox"
                  checked={timeOptOn}
                  disabled={!commonOn}
                  onChange={(e) => setTimeOptOn(e.target.checked)}
                />
                Time opt
              </label>
              <label title="Grid step for sweeping entry-start from After up to Before − Step">
                Step
                <select
                  disabled={!commonOn || !timeOptOn}
                  value={timeStep}
                  onChange={(e) => setTimeStep(Number(e.target.value) === 60 ? 60 : 30)}
                >
                  <option value={30}>30m</option>
                  <option value={60}>1h</option>
                </select>
              </label>
              <div style={{ opacity: commonOn ? 1 : 0.45 }}>
                <label title="Entry window start (IST). With Time opt: first start time in the sweep">
                  After
                  <input
                    type="time"
                    disabled={!commonOn}
                    value={minsToTime(entryAfter)}
                    onChange={(e) => setEntryAfter(timeToMins(e.target.value))}
                  />
                </label>
                <label title="Entry window end (IST). New entries only while After ≤ clock < Before">
                  Before
                  <input
                    type="time"
                    disabled={!commonOn}
                    value={minsToTime(entryBefore)}
                    onChange={(e) => setEntryBefore(timeToMins(e.target.value))}
                  />
                </label>
                <label title="Force-flat / square-off (IST). Open positions close here; must be ≥ Before">
                  Flat
                  <input
                    type="time"
                    disabled={!commonOn}
                    value={minsToTime(exitTime)}
                    onChange={(e) => setExitTime(timeToMins(e.target.value))}
                  />
                </label>
              </div>
              <div className="dow-chips compact">
                {DOW.map(([key, lab]) => (
                  <button
                    key={key}
                    type="button"
                    className={`dow-chip ${days.has(key) ? 'on' : ''}`}
                    disabled={!commonOn || busy}
                    onClick={() => toggleDay(key)}
                    title="Bars filter (re-run to apply)"
                  >
                    {lab}
                  </button>
                ))}
              </div>
              <span className="opt-est">
                {timeOptOn
                  ? `~${estSessions} starts · ${minsToTime(entryAfter)}→${minsToTime(entryAfterTo)} / before ${minsToTime(entryBefore)} · flat ${minsToTime(exitTime)}`
                  : `${minsToTime(entryAfter)}–${minsToTime(entryBefore)} · flat ${minsToTime(exitTime)}`}
              </span>
            </section>

            <section className="opt-cfg-card">
              <h3>Execution &amp; Ranking</h3>
              <label>
                Rank
                <select value={rankBy} onChange={(e) => setRankBy(e.target.value)}>
                  {RANK_OPTIONS.map(([v, lab]) => (
                    <option key={v} value={v}>
                      {lab}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Workers
                <select value={workers} onChange={(e) => setWorkers(Number(e.target.value))}>
                  <option value={0}>Auto</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                  <option value={6}>6</option>
                  <option value={8}>8</option>
                </select>
              </label>
              <button
                type="button"
                className="opt-run-btn"
                disabled={busy || !dataReady}
                onClick={run}
              >
                {busy ? '…' : 'RUN GRID SEARCH'}
              </button>
              {busy && (
                <button type="button" className="ghost danger" onClick={() => onStop?.()}>
                  Stop
                </button>
              )}
              {best && (
                <button type="button" className="ghost" onClick={onApplyBest} disabled={busy}>
                  Apply best
                </button>
              )}
            </section>
          </div>
        )}

        {subTab === 'heatmap' && (
          <div className="opt-heat-layout">
            <div className="opt-heat-top">
              {result && result.results.length > 0 ? (
                <OptimizeHeatmap
                  results={result.results}
                  selectedKey={selectedComboKey}
                  onSelect={selectCombo}
                  preferTimeSurface={timeOptActive}
                />
              ) : (
                <p className="opt-empty">Run optimize to see the parameter heatmap.</p>
              )}
            </div>
            {vsBest && overview && best && (
              <div className="opt-vs-best">
                <span className="opt-vs-best-lab">SELECTED vs BEST</span>
                <span className={vsBest.sharpe >= 0 ? 'pos' : 'neg'} title="Δ Sharpe">
                  Sharpe {vsBest.sharpe >= 0 ? '+' : ''}
                  {fmt2(vsBest.sharpe)}
                </span>
                <span className={vsBest.net >= 0 ? 'pos' : 'neg'} title="Δ Net PnL">
                  Net {vsBest.net >= 0 ? '+' : ''}
                  {fmt2(vsBest.net)}
                </span>
                <span className={vsBest.pf >= 0 ? 'pos' : 'neg'} title="Δ Profit Factor">
                  PF {vsBest.pf >= 0 ? '+' : ''}
                  {fmt2(vsBest.pf)}
                </span>
                <span className={vsBest.win >= 0 ? 'pos' : 'neg'} title="Δ Win %">
                  Win% {vsBest.win >= 0 ? '+' : ''}
                  {fmt2(vsBest.win)}
                </span>
                <span className={vsBest.trades >= 0 ? 'pos' : 'neg'} title="Δ Trades">
                  Trades {vsBest.trades >= 0 ? '+' : ''}
                  {vsBest.trades}
                </span>
                <span
                  className={vsBest.dd <= 0 ? 'pos' : 'neg'}
                  title="Δ Max DD (lower is better)"
                >
                  MaxDD {vsBest.dd >= 0 ? '+' : ''}
                  {fmt2(vsBest.dd)}
                </span>
                <span className={vsBest.sqn >= 0 ? 'pos' : 'neg'} title="Δ SQN">
                  SQN {vsBest.sqn >= 0 ? '+' : ''}
                  {fmt2(vsBest.sqn)}
                </span>
                <span className="opt-vs-best-meta">
                  vs thr {fmt2(best.threshold)} / RR {fmt2(best.rr)} /{' '}
                  {minsToTime(Number(best.entry_after ?? 0))}
                </span>
              </div>
            )}
            <div className="opt-heat-bottom">
              <section className="opt-heat-hour">
                <div className="opt-card-h row">
                  <span>ENTRY HOUR DISTRIBUTION (IST) — by entry time</span>
                  <div className="opt-hour-modes">
                    {(
                      [
                        ['pnl', 'Net PnL'],
                        ['trades', 'Trades'],
                        ['cost', 'Slip+Fee'],
                      ] as const
                    ).map(([id, lab]) => (
                      <button
                        key={id}
                        type="button"
                        className={`ghost${hourMode === id ? ' on' : ''}`}
                        onClick={() => setHourMode(id)}
                      >
                        {lab}
                      </button>
                    ))}
                    {filterHours && (
                      <button type="button" className="ghost" onClick={() => setFilterHours(null)}>
                        Reset
                      </button>
                    )}
                  </div>
                </div>
                <p className="opt-best-meta">
                  Hours use each trade&apos;s <b>entry</b> clock (IST), not exit. Bars show the selected
                  metric as labels. Click hours to filter; Apply sends those hours into the backtest
                  engine.
                </p>
                {result && (
                  <div className="dow-chips compact" style={{ marginBottom: 8 }}>
                    {DOW.map(([key, lab]) => (
                      <button
                        key={`f-${key}`}
                        type="button"
                        className={`dow-chip ${filterDays.has(key) ? 'on' : ''}`}
                        disabled={busy}
                        onClick={() => toggleFilterDay(key)}
                      >
                        {lab}
                      </button>
                    ))}
                  </div>
                )}
                <div className="hour-heat compact">
                  <div className="hour-heat-grid">
                    {Array.from({ length: 24 }, (_, h) => {
                      const b = hourBuckets[h]
                      const selected = filterHours === null || filterHours.has(h)
                      const mag =
                        hourMode === 'trades'
                          ? b.trades
                          : hourMode === 'pnl'
                            ? Math.abs(b.pnl)
                            : b.cost
                      const intensity = mag / hourMax
                      const empty = mag <= 0
                      let bg = '#27272a'
                      if (!empty) {
                        if (hourMode === 'pnl') {
                          bg =
                            b.pnl >= 0
                              ? `rgba(34, 197, 94, ${0.25 + intensity * 0.75})`
                              : `rgba(239, 68, 68, ${0.25 + intensity * 0.75})`
                        } else if (hourMode === 'cost') {
                          bg = `rgba(245, 158, 11, ${0.2 + intensity * 0.75})`
                        } else {
                          bg = selected
                            ? `rgba(34, 197, 94, ${0.25 + intensity * 0.75})`
                            : `rgba(113, 113, 122, ${0.2 + intensity * 0.35})`
                        }
                        if (!selected) bg = bg.replace(/[\d.]+\)$/, '0.25)')
                      }
                      const tip =
                        hourMode === 'pnl'
                          ? `${h}:00 → net ${fmt2(b.pnl)} · ${b.trades} trades`
                          : hourMode === 'cost'
                            ? `${h}:00 → slip+fee ${fmt2(b.cost)} · ${b.trades} trades`
                            : `${h}:00 → ${b.trades} trades`
                      const valLab =
                        hourMode === 'pnl'
                          ? b.trades
                            ? fmt2(b.pnl)
                            : ''
                          : hourMode === 'cost'
                            ? b.trades
                              ? fmt2(b.cost)
                              : ''
                            : b.trades
                              ? String(b.trades)
                              : ''
                      return (
                        <button
                          key={h}
                          type="button"
                          className={`hour-heat-cell ${selected ? 'on' : 'off'}`}
                          title={tip}
                          disabled={!result}
                          onClick={() => toggleFilterHour(h)}
                        >
                          <span className="hour-heat-val">{valLab}</span>
                          <div
                            className="hour-heat-bar"
                            style={{
                              height: `${Math.max(4, Math.round(intensity * 36))}px`,
                              background: bg,
                            }}
                          />
                          <span className="hour-heat-lab">{String(h).padStart(2, '0')}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </section>

              <section className="opt-heat-best">
                <div className="opt-card-h">
                  {overviewIsSelected ? 'SELECTED COMBO → BACKTEST' : 'TOP COMBO OVERVIEW'}
                </div>
                {overview ? (
                  <>
                    <p className="opt-best-meta">
                      {overviewIsSelected
                        ? 'Showing the combo selected from Results / Analysis. Apply loads it into Backtest.'
                        : 'Showing rank #1. Click an Analysis cell or Results row to inspect that combo here.'}
                    </p>
                    <div className="opt-best-main">
                      <span>
                        thr <b>{fmt2(overview.threshold)}</b>
                      </span>
                      <span>
                        RR <b>{fmt2(overview.rr)}</b>
                      </span>
                      <span>
                        Vol <b>{fmt2(Number(overview.volume ?? result?.volume ?? 0))}</b>
                      </span>
                      <span>
                        {overview.pro_mtf_mode
                          ? 'Pro-MTF'
                          : overview.pro_mode
                            ? 'Pro'
                            : overview.wait_and_trade
                              ? 'Non-Dir'
                              : 'Dir'}
                      </span>
                      <span>
                        BE{' '}
                        <b>
                          {Number(overview.break_even)
                            ? String(overview.be_unit) === 'range'
                              ? `On Range CTC ${fmt2(Number(overview.be_ctc ?? 2))}`
                              : String(overview.be_unit) === 'pct'
                                ? `On ${fmt2(Number(overview.be_value ?? overview.break_even_pct ?? 0))}% CTC ${fmt2(Number(overview.be_ctc ?? 2))}`
                                : `On ${fmt2(Number(overview.be_value ?? 0))} ${String(overview.be_unit || '')} CTC ${fmt2(Number(overview.be_ctc ?? 2))}`
                            : 'Off'}
                        </b>
                      </span>
                      <span className={Number(overview.net_pnl) >= 0 ? 'pos' : 'neg'}>
                        net <b>{fmt2(overview.net_pnl)}</b>
                      </span>
                      <span
                        className={
                          Number(overview.gross_pnl ?? Number(overview.net_pnl) + Number(overview.total_fees ?? 0)) >= 0
                            ? 'pos'
                            : 'neg'
                        }
                      >
                        gross{' '}
                        <b>
                          {fmt2(
                            Number(
                              overview.gross_pnl ??
                                Number(overview.net_pnl) + Number(overview.total_fees ?? 0),
                            ),
                          )}
                        </b>
                      </span>
                      <span className="neg">
                        slip <b>{fmtCost(Number(overview.total_slippage ?? 0))}</b>
                      </span>
                      <span className="neg">
                        fees <b>{fmtCost(Number(overview.total_fees ?? 0))}</b>
                      </span>
                      <span className="neg">
                        cost{' '}
                        <b>
                          {fmtCost(
                            Number(
                              overview.total_cost ??
                                Number(overview.total_slippage ?? 0) +
                                  Number(overview.total_fees ?? 0),
                            ),
                          )}
                        </b>
                      </span>
                      <span>
                        sharpe <b>{fmt2(overview.sharpe)}</b>
                      </span>
                      <span>
                        SQN <b>{fmt2(Number(overview.sqn ?? 0))}</b>
                      </span>
                      <span>
                        E-ratio <b>{fmt2(Number(overview.e_ratio ?? 0))}</b>
                      </span>
                      <span>
                        win% <b>{fmtPct(overview.win_rate)}%</b>
                      </span>
                      <span>
                        trades <b>{overview.trades}</b>
                      </span>
                      <span>
                        PF <b>{fmt2(overview.profit_factor)}</b>
                      </span>
                      <span className="neg">
                        maxDD <b>{fmt2(overview.max_drawdown)}</b>
                      </span>
                      <span>
                        {minsToTime(Number(overview.entry_after ?? 0))}–
                        {minsToTime(Number(overview.entry_before ?? 0))} flat{' '}
                        {minsToTime(Number(overview.exit_time ?? 0))}
                      </span>
                    </div>
                    {equitySpark.length > 1 && (
                      <svg
                        className="opt-equity-spark"
                        viewBox={`0 0 ${equitySpark.length - 1} 56`}
                        preserveAspectRatio="none"
                        aria-label="Equity curve preview"
                      >
                        <polyline
                          fill="none"
                          stroke={Number(overview.net_pnl) >= 0 ? '#22c55e' : '#ef4444'}
                          strokeWidth="1.5"
                          vectorEffect="non-scaling-stroke"
                          points={equitySpark
                            .map((y, i) => `${i},${56 - ((y - sparkMin) / sparkRange) * 52 - 2}`)
                            .join(' ')}
                        />
                      </svg>
                    )}
                    {filteredOverview && (
                      <div className="opt-best-meta">
                        View filter: {filteredOverview.trades} trades / net{' '}
                        {fmt2(filteredOverview.net_pnl)} (cell {overview?.trades} /{' '}
                        {fmt2(Number(overview?.net_pnl))}). Equity spark uses the filter; Apply
                        runs the full combo then keeps the same entry-hour / day trades (matches
                        this view).
                      </div>
                    )}
                    {filteredBest && !overviewIsSelected && !filteredOverview && (
                      <div className="opt-best-meta">
                        filtered {filteredBest.trades} / net {fmt2(filteredBest.net_pnl)}
                      </div>
                    )}
                    <button
                      type="button"
                      className="opt-run-btn"
                      disabled={busy}
                      onClick={() => {
                        if (overview) applyCombo(overview, viewFilterForApply)
                        else onApplyBest()
                      }}
                    >
                      {viewFilterForApply?.allowed_entry_hours || viewFilterForApply?.dayofweek
                        ? 'Apply filtered to Backtest'
                        : 'Apply to Backtest'}
                    </button>
                  </>
                ) : (
                  <p className="opt-empty">
                    Run optimize, then select a Results row or Analysis cell to study a combo
                    here before applying to Backtest.
                  </p>
                )}
              </section>
            </div>
          </div>
        )}

        {subTab === 'leaderboard' && (
          <div className="opt-lb-layout">
            <div className="opt-lb-hint">
              Column filters support text match or numeric ops: <code>&gt;1</code>, <code>&lt;5</code>,{' '}
              <code>10-20</code>. Unused SL/TP/Trail/BE/Pro columns are hidden when that feature
              is off for the whole run. Net = Gross PnL − Fee $ (slip is already in Entry/Exit). Total
              Cost = Slip $ + Fee $ is not subtracted twice, and is not Gross−. Row CSV matches
              visible columns + trades. Click a row to inspect on Analysis; use Apply to Backtest
              there.
            </div>
            <div className="opt-lb-table-wrap">
              {result ? (
                <table className="opt-table-inner opt-report-table">
                  <thead>
                    <tr>
                      <th className="opt-col-param" title="Rank">
                        #
                      </th>
                      <th className="opt-col-param" title="Download combo detail CSV">
                        CSV
                      </th>
                      {reportCols.map((c) => {
                        const sk = c.sortKey ?? c.key
                        const cls =
                          c.section === 'param'
                            ? 'opt-col-param'
                            : c.section === 'equity'
                              ? 'opt-col-equity'
                              : 'opt-col-metric'
                        if (c.format === 'spark') {
                          return (
                            <th key={c.key} className={cls} title="Mini equity chart">
                              {c.label}
                            </th>
                          )
                        }
                        return (
                          <SortTh
                            key={c.key}
                            col={sk}
                            sort={optSort.sort}
                            onSort={optSort.toggle}
                            className={cls}
                          >
                            {c.label}
                          </SortTh>
                        )
                      })}
                    </tr>
                    <tr className="opt-filter-row">
                      <th className="opt-col-param" />
                      <th className="opt-col-param" />
                      {reportCols.map((c) => {
                        const fk = c.sortKey ?? c.key
                        const cls =
                          c.section === 'param'
                            ? 'opt-col-param'
                            : c.section === 'equity'
                              ? 'opt-col-equity'
                              : 'opt-col-metric'
                        if (c.format === 'spark') {
                          return <th key={`f-${c.key}`} className={cls} />
                        }
                        return (
                          <th key={`f-${c.key}`} className={cls}>
                            <input
                              className="opt-col-filter"
                              value={colFilters[fk] ?? ''}
                              placeholder="filter"
                              title={`${c.label}: text or >1 <5 10-20`}
                              onChange={(e) =>
                                setColFilters((prev) => ({ ...prev, [fk]: e.target.value }))
                              }
                              onClick={(e) => e.stopPropagation()}
                            />
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {optSort.sorted.map((r, idx) => {
                      const risk = overfitKeys.has(r._key)
                      const sel = selectedComboKey === r._key
                      const spark = Array.isArray(r.equity_spark) ? r.equity_spark : null
                      const rec = r as unknown as Record<string, unknown>
                      return (
                        <tr
                          key={r._rank}
                          className={`${r._rank === 0 ? 'best' : ''}${risk ? ' overfit-row' : ''}${sel ? ' selected-row' : ''}`}
                          onClick={() => selectCombo(r as unknown as OptimizePoint)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td className="opt-col-param">{idx + 1}</td>
                          <td className="opt-col-param opt-csv-cell">
                            <button
                              type="button"
                              className="opt-row-csv"
                              title="Download this combo’s full optimize result CSV"
                              onClick={(e) => downloadRowCsv(r, e)}
                            >
                              ⬇
                            </button>
                          </td>
                          {reportCols.map((c) => {
                            const cls =
                              c.section === 'param'
                                ? 'opt-col-param'
                                : c.section === 'equity'
                                  ? 'opt-col-equity'
                                  : 'opt-col-metric'
                            if (c.format === 'spark') {
                              return (
                                <td key={c.key} className={`opt-mini-cell ${cls}`}>
                                  <MiniEquityChart spark={spark} />
                                </td>
                              )
                            }
                            if (c.format === 'robust') {
                              return (
                                <td key={c.key} className={cls}>
                                  {r._robust}
                                </td>
                              )
                            }
                            if (c.format === 'time') {
                              const mins =
                                c.key === 'after'
                                  ? Number(r.entry_after ?? 0)
                                  : c.key === 'before'
                                    ? Number(r.entry_before ?? 0)
                                    : Number(r.exit_time ?? 0)
                              return (
                                <td key={c.key} className={cls}>
                                  {minsToTime(mins)}
                                </td>
                              )
                            }
                            if (c.key === 'strategy') {
                              return (
                                <td key={c.key} className={cls}>
                                  {r._strategy}
                                </td>
                              )
                            }
                            if (c.key === 'be') {
                              return (
                                <td key={c.key} className={cls}>
                                  {r._be}
                                </td>
                              )
                            }
                            if (c.key === 'break_even_pct') {
                              return (
                                <td key={c.key} className={cls}>
                                  {r._be === '—' || r._be === 'Off' ? '—' : fmt2(Number(r._bePct))}
                                </td>
                              )
                            }
                            const raw = c.get ? c.get(rec) : rec[c.key]
                            const n = Number(raw)
                            const signed =
                              c.key === 'net_pnl' || c.key === 'gross_pnl' || c.key === 'avg_loss' || c.key === 'gross_loss'
                            const className =
                              signed && Number.isFinite(n)
                                ? `${cls} ${n >= 0 ? 'pos' : 'neg'}`
                                : cls
                            if (c.format === 'text') {
                              return (
                                <td key={c.key} className={cls}>
                                  {String(raw ?? '—')}
                                </td>
                              )
                            }
                            if (c.format === 'cost' || c.key === 'total_slippage' || c.key === 'total_fees' || c.key === 'total_cost') {
                              return (
                                <td key={c.key} className={`${cls} ${Number.isFinite(n) && n ? 'neg' : ''}`.trim()}>
                                  {raw == null || raw === '' ? '—' : fmtCost(n)}
                                </td>
                              )
                            }
                            return (
                              <td key={c.key} className={className}>
                                {raw == null || raw === '' ? '—' : fmt2(n)}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="opt-empty">
                  {busy
                    ? `Running… ${progress?.done ?? 0}/${progress?.total ?? 0} combos will appear here as they finish.`
                    : 'No results yet.'}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}