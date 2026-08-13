import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BacktestStats, OptimizePoint, OptimizeResult, SystemResources } from '../api'
import { fetchSystemResources } from '../api'
import { fmt2, fmtPct } from '../format'
import { downloadOptimizeCsv } from '../metricsCatalog'
import { MetricsPanel } from '../components/MetricsPanel'
import { SortTh, useSortable } from '../useSortable'
import { OptimizeHeatmap } from '../dashboard/OptimizeHeatmap'
import { comboKey, flagOverfitRisk } from '../dashboard/overfitHeuristic'

export type OptimizeGrid = {
  thresholds: string
  rrs: string
  wait_flags: string
  re_entry_flags: string
  stop_to_be_flags: string
  break_even_flags: string
  break_even_pcts: string
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
  /** 0 = auto (CPU-1, capped at 4) */
  workers: number
}

type Props = {
  result: OptimizeResult | null
  busy: boolean
  dataReady: boolean
  progress?: { done: number; total: number; workers?: number } | null
  defaultEntryAfter?: number
  defaultEntryBefore?: number
  defaultExitTime?: number
  defaultSlip?: number
  defaultFee?: number
  onRun: (grid: OptimizeGrid) => void
  onStop?: () => void
  onApplyBest: () => void
  onLoadCombo?: (point: OptimizePoint) => void
}

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

export function OptimizeTab({
  result,
  busy,
  dataReady,
  progress,
  defaultEntryAfter = 330,
  defaultEntryBefore = 1260,
  defaultExitTime = 1260,
  defaultSlip = 0,
  defaultFee = 0,
  onRun,
  onStop,
  onApplyBest,
  onLoadCombo,
}: Props) {
  const [thresholds, setThresholds] = useState('40,50,60')
  const [rrs, setRrs] = useState('0.5,1,1.5,2')
  const [waitFlags, setWaitFlags] = useState('false')
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
  const [slipPcts, setSlipPcts] = useState(
    defaultSlip > 0 ? `0,${defaultSlip}` : '0,0.01',
  )
  const [feePcts, setFeePcts] = useState(defaultFee > 0 ? `0,${defaultFee}` : '0,0.01')
  const [minTrades, setMinTrades] = useState(3)
  const [timeStopMin, setTimeStopMin] = useState(0)
  const [timeStopOn, setTimeStopOn] = useState(false)
  const [beOff, setBeOff] = useState(true)
  const [beOn, setBeOn] = useState(true)
  const [bePcts, setBePcts] = useState('50')
  const [workers, setWorkers] = useState(0)
  const [resources, setResources] = useState<SystemResources | null>(null)
  const [selectedComboKey, setSelectedComboKey] = useState<string | null>(null)

  const lastGrid = useRef<OptimizeGrid | null>(null)
  const [filterDays, setFilterDays] = useState<Set<string>>(
    () => new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  )
  const [filterHours, setFilterHours] = useState<Set<number> | null>(null)

  const breakEvenFlags = useMemo(() => {
    const parts: string[] = []
    if (beOff) parts.push('0')
    if (beOn) parts.push('1')
    return parts.join(',') || '0'
  }, [beOff, beOn])

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

  const buildGrid = (dayStr: string): OptimizeGrid => ({
    thresholds,
    rrs,
    wait_flags: waitFlags,
    re_entry_flags: '0',
    stop_to_be_flags: '0',
    break_even_flags: breakEvenFlags,
    break_even_pcts: bePcts.trim() || '50',
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
    slippage_pcts: slipPcts,
    fee_pcts: feePcts,
    min_trades: Math.max(0, minTrades),
    time_stop_minutes: timeStopOn ? Math.max(30, timeStopMin || 90) : 0,
    workers: Math.max(0, Math.floor(workers)),
  })

  useEffect(() => {
    if (!result) return
    setFilterDays(new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))
    setFilterHours(null)
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
    filteredBest?.entry_hours || result?.entry_hour_heatmap || result?.best?.entry_hours || null
  const heatMax = heatmap
    ? Math.max(1, ...Object.values(heatmap).map((n) => Number(n) || 0))
    : 1

  const optRows = useMemo(
    () =>
      (result?.results ?? []).map((r, i) => ({
        ...r,
        _rank: i,
        _strategy: r.wait_and_trade ? 'Non-Dir' : 'Dir',
        _be: r.wait_and_trade ? '—' : Number(r.break_even) ? 'On' : 'Off',
        _bePct:
          r.wait_and_trade || !Number(r.break_even) ? -1 : Number(r.break_even_pct ?? 50),
        _key: comboKey(r),
      })),
    [result?.results],
  )

  const overfitKeys = useMemo(
    () => flagOverfitRisk((result?.results ?? []) as OptimizePoint[]),
    [result?.results],
  )

  const optGet = useCallback((row: (typeof optRows)[number], key: string): unknown => {
    return (row as unknown as Record<string, unknown>)[key]
  }, [])

  const optSort = useSortable(optRows, optGet, { key: '_rank', dir: 'asc' })

  const loadCombo = (point: OptimizePoint) => {
    setSelectedComboKey(comboKey(point))
    onLoadCombo?.(point)
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

  const onCsv = () => {
    if (!result?.results?.length) return
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    downloadOptimizeCsv(result.results as unknown as Record<string, unknown>[], `optimize-${stamp}.csv`)
  }

  const run = () => {
    const dayStr = daysToStr(days)
    const grid = buildGrid(dayStr)
    lastGrid.current = grid
    onRun(grid)
  }

  const best = result?.best

  return (
    <div className="opt-shell">
      {/* —— Top control bar (2 rows) —— */}
      <div className="opt-topbar">
        <div className="opt-topbar-row">
          <div className="opt-title-block">
            <h2>Optimize</h2>
            {!dataReady && <span className="opt-warn">Load data first</span>}
      </div>
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
          <label>
            Slip%
            <input
              className="num-plain"
              disabled={!commonOn}
              value={slipPcts}
              onChange={(e) => setSlipPcts(e.target.value)}
            />
        </label>
          <label>
            Fee%
            <input
              className="num-plain"
              disabled={!commonOn}
              value={feePcts}
              onChange={(e) => setFeePcts(e.target.value)}
            />
          </label>
          <label>
            Min trades
            <input
              className="num-plain"
              type="number"
              min={0}
              disabled={!commonOn}
              value={minTrades}
              onChange={(e) => setMinTrades(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
          <label className="check opt-toggle">
            <input
              type="checkbox"
              disabled={!commonOn}
              checked={timeStopOn}
              onChange={(e) => {
                setTimeStopOn(e.target.checked)
                if (e.target.checked && timeStopMin <= 0) setTimeStopMin(90)
              }}
            />
            TStop
          </label>
        <label>
            Thr
          <input value={thresholds} onChange={(e) => setThresholds(e.target.value)} />
        </label>
        <label>
            RR
          <input value={rrs} onChange={(e) => setRrs(e.target.value)} />
        </label>
        <label>
            Strategy
            <input
              value={waitFlags}
              onChange={(e) => setWaitFlags(e.target.value)}
              placeholder="false"
              title="false=Directional, true=Non-Directional"
            />
          </label>
          <label title="Directional BreakEven">
            BE
            <div className="be-opt-flags">
              <label className="check">
                <input
                  type="checkbox"
                  checked={beOff}
                  onChange={(e) => {
                    const on = e.target.checked
                    if (!on && !beOn) return
                    setBeOff(on)
                  }}
                />
                Off
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={beOn}
                  onChange={(e) => {
                    const on = e.target.checked
                    if (!on && !beOff) return
                    setBeOn(on)
                  }}
                />
                On
              </label>
            </div>
        </label>
          <label>
            BE%
            <input
              value={bePcts}
              disabled={!beOn}
              onChange={(e) => setBePcts(e.target.value)}
              placeholder="50"
            />
        </label>
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
          <button disabled={busy || !dataReady} onClick={run}>
            {busy ? '…' : 'Run'}
          </button>
          {busy && (
            <button type="button" className="ghost danger" onClick={() => onStop?.()}>
              Stop
            </button>
          )}
          {best && (
            <button className="ghost" onClick={onApplyBest} disabled={busy}>
              Apply best
        </button>
          )}
          <button className="ghost" disabled={!result?.results?.length} onClick={onCsv}>
            CSV
          </button>
        </div>

        <div className="opt-topbar-row opt-time-row" style={{ opacity: commonOn ? 1 : 0.45 }}>
          <span className="opt-lab">Hours (IST)</span>
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
          <span className="opt-est">
            {timeOptOn
              ? `~${estSessions} starts · ${minsToTime(entryAfter)}→${minsToTime(entryAfterTo)} / before ${minsToTime(entryBefore)} · flat ${minsToTime(exitTime)}`
              : `${minsToTime(entryAfter)}–${minsToTime(entryBefore)} · flat ${minsToTime(exitTime)}`}
          </span>
        </div>

        {(busy || (progress && progress.total > 0)) && (
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
                {busy
                  ? `${progress?.done ?? 0} / ${progress?.total || '…'}`
                  : 'Done'}
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
      </div>

      {/* —— Body: 2-column split —— */}
      <div className="opt-body">
        <aside className="opt-left">
          <section className="opt-card">
            <div className="opt-card-h">DAY OF WEEK</div>
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
            {result && (
              <>
                <div className="opt-card-h" style={{ marginTop: 8 }}>
                  RESULTS FILTER
                </div>
                <div className="dow-chips compact">
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
        </>
      )}
          </section>

          <section className="opt-card opt-best-tile">
            <div className="opt-card-h">TOP COMBO</div>
            {best ? (
              <>
                <div className="opt-best-main">
                  <span>
                    thr <b>{fmt2(best.threshold)}</b>
                  </span>
                  <span>
                    RR <b>{fmt2(best.rr)}</b>
                  </span>
                  <span>{best.wait_and_trade ? 'Non-Dir' : 'Dir'}</span>
                </div>
                <div className="opt-best-metrics">
                  <div>
                    <em>Net</em>
                    <b className={Number(best.net_pnl) >= 0 ? 'pos' : 'neg'}>
                      {fmt2(best.net_pnl)}
                    </b>
                  </div>
                  <div>
                    <em>Sharpe</em>
                    <b>{fmt2(best.sharpe)}</b>
                  </div>
                  <div>
                    <em>Win%</em>
                    <b>{fmtPct(best.win_rate)}%</b>
                  </div>
                  <div>
                    <em>Trades</em>
                    <b>{best.trades}</b>
                  </div>
                  <div>
                    <em>PF</em>
                    <b>{fmt2(best.profit_factor)}</b>
                  </div>
                  <div>
                    <em>MaxDD</em>
                    <b className="neg">{fmt2(best.max_drawdown)}</b>
                  </div>
                </div>
                <div className="opt-best-meta">
                  {minsToTime(Number(best.entry_after ?? 0))}–
                  {minsToTime(Number(best.entry_before ?? 0))} flat{' '}
                  {minsToTime(Number(best.exit_time ?? 0))}
                  {filteredBest
                    ? ` · filtered ${filteredBest.trades} / net ${fmt2(filteredBest.net_pnl)}`
                    : ''}
                </div>
              </>
            ) : (
              <p className="opt-empty">Run optimize to see the best combo.</p>
            )}
          </section>

          <section className="opt-card opt-metrics-tile">
            <div className="opt-card-h">KEY METRICS</div>
            {best ? (
              <MetricsPanel stats={best as unknown as BacktestStats} />
            ) : (
              <p className="opt-empty">—</p>
            )}
          </section>
        </aside>

        <div className="opt-right">
          <section className="opt-card opt-hour-card">
            <div className="opt-card-h row">
              <span>ENTRY HOUR (IST)</span>
              {filterHours && (
                <button type="button" className="ghost" onClick={() => setFilterHours(null)}>
                  Reset
                </button>
              )}
            </div>
            <div className="hour-heat compact">
              <div className="hour-heat-grid">
                {Array.from({ length: 24 }, (_, h) => {
                  const n = Number(heatmap?.[String(h)] || 0)
                  const intensity = n / heatMax
                  const selected = filterHours === null || filterHours.has(h)
                  return (
                    <button
                      key={h}
                      type="button"
                      className={`hour-heat-cell ${selected ? 'on' : 'off'}`}
                      title={`${h}:00 → ${n}`}
                      disabled={!result}
                      onClick={() => toggleFilterHour(h)}
                    >
                      <div
                        className="hour-heat-bar"
                        style={{
                          height: `${Math.max(4, Math.round(intensity * 36))}px`,
                          background:
                            n === 0
                              ? '#27272a'
                              : selected
                                ? `rgba(34, 197, 94, ${0.25 + intensity * 0.75})`
                                : `rgba(113, 113, 122, ${0.2 + intensity * 0.35})`,
                        }}
                      />
                      <span className="hour-heat-lab">{String(h).padStart(2, '0')}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </section>

          <section className="opt-card opt-param-heat">
            {result && result.results.length > 0 ? (
              <OptimizeHeatmap
                results={result.results}
                selectedKey={selectedComboKey}
                onSelect={loadCombo}
              />
            ) : (
              <>
                <div className="opt-card-h">PARAM HEATMAP — Thr × RR</div>
                <p className="opt-empty">Heatmap appears after a run.</p>
              </>
            )}
          </section>

          <section className="opt-card opt-table-card">
            <div className="opt-card-h">RESULTS</div>
            <div className="opt-table-scroll">
              {result ? (
                <table className="opt-table-inner">
            <thead>
              <tr>
                      <th title="Overfit risk">⚠</th>
                      <SortTh col="threshold" sort={optSort.sort} onSort={optSort.toggle}>
                        Thr
                      </SortTh>
                      <SortTh col="rr" sort={optSort.sort} onSort={optSort.toggle}>
                        RR
                      </SortTh>
                      <SortTh col="_strategy" sort={optSort.sort} onSort={optSort.toggle}>
                        Strat
                      </SortTh>
                      <SortTh col="_be" sort={optSort.sort} onSort={optSort.toggle}>
                        BE
                      </SortTh>
                      <SortTh col="entry_after" sort={optSort.sort} onSort={optSort.toggle}>
                        After
                      </SortTh>
                      <SortTh col="entry_before" sort={optSort.sort} onSort={optSort.toggle}>
                        Before
                      </SortTh>
                      <SortTh col="exit_time" sort={optSort.sort} onSort={optSort.toggle}>
                        Flat
                      </SortTh>
                      <SortTh col="trades" sort={optSort.sort} onSort={optSort.toggle}>
                        N
                      </SortTh>
                      <SortTh col="net_pnl" sort={optSort.sort} onSort={optSort.toggle}>
                        Net
                      </SortTh>
                      <SortTh col="sharpe" sort={optSort.sort} onSort={optSort.toggle}>
                        Sharpe
                      </SortTh>
                      <SortTh col="sortino" sort={optSort.sort} onSort={optSort.toggle}>
                        Sortino
                      </SortTh>
                      <SortTh col="profit_factor" sort={optSort.sort} onSort={optSort.toggle}>
                        PF
                      </SortTh>
                      <SortTh col="win_rate" sort={optSort.sort} onSort={optSort.toggle}>
                        Win%
                      </SortTh>
                      <SortTh col="max_drawdown" sort={optSort.sort} onSort={optSort.toggle}>
                        DD
                      </SortTh>
              </tr>
            </thead>
            <tbody>
                    {optSort.sorted.map((r) => {
                      const risk = overfitKeys.has(r._key)
                      const sel = selectedComboKey === r._key
                      return (
                        <tr
                          key={r._rank}
                          className={`${r._rank === 0 ? 'best' : ''}${risk ? ' overfit-row' : ''}${sel ? ' selected-row' : ''}`}
                          onClick={() => loadCombo(r as unknown as OptimizePoint)}
                          style={{ cursor: onLoadCombo ? 'pointer' : undefined }}
                        >
                          <td>{risk ? '⚠' : ''}</td>
                  <td>{fmt2(r.threshold)}</td>
                  <td>{fmt2(r.rr)}</td>
                          <td>{r._strategy}</td>
                          <td>{r._be}</td>
                          <td>{minsToTime(Number(r.entry_after ?? 0))}</td>
                          <td>{minsToTime(Number(r.entry_before ?? 0))}</td>
                          <td>{minsToTime(Number(r.exit_time ?? 0))}</td>
                  <td>{r.trades}</td>
                  <td className={r.net_pnl >= 0 ? 'pos' : 'neg'}>{fmt2(r.net_pnl)}</td>
                  <td>{fmt2(r.sharpe)}</td>
                          <td>{fmt2(Number(r.sortino ?? 0))}</td>
                  <td>{fmt2(r.profit_factor)}</td>
                  <td>{fmt2(r.win_rate)}</td>
                  <td>{fmt2(r.max_drawdown)}</td>
                </tr>
                      )
                    })}
            </tbody>
          </table>
              ) : (
                <p className="opt-empty">No results yet.</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
