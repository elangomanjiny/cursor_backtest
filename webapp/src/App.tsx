import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchBacktest,
  fetchDataStatus,
  fetchHealth,
  fetchOptimize,
  loadData,
  OptimizeCancelledError,
  type BacktestResult,
  type DataAvailability,
  type OptimizePoint,
  type OptimizeResult,
  type StrategyParams,
  type TradeRow,
} from './api'
import { clearChartRange } from './chartZoomStore'
import { loadSavedParams, saveSavedParams } from './userSettingsStore'
import { resetChartStudy } from './chartStudyStore'
import { BacktestStep } from './steps/BacktestStep'
import { DataLoaderStep } from './steps/DataLoaderStep'
import { OptimizeTab, type OptimizeGrid } from './tabs/OptimizeTab'
import { OrderflowTab } from './tabs/OrderflowTab'
import './App.css'

type Step = 1 | 2 | 3 | 4

function mergeLiveOpt(
  prev: OptimizeResult | null,
  row: OptimizePoint,
  rankBy: string,
): OptimizeResult {
  const results = [...(prev?.results ?? []), row]
  const reverse = rankBy !== 'max_drawdown'
  results.sort((a, b) => {
    const av = Number((a as Record<string, unknown>)[rankBy] ?? a.net_pnl)
    const bv = Number((b as Record<string, unknown>)[rankBy] ?? b.net_pnl)
    if (bv === av) return Number(b.net_pnl) - Number(a.net_pnl)
    return reverse ? bv - av : av - bv
  })
  return {
    ...prev,
    rank_by: rankBy,
    metric_columns: prev?.metric_columns ?? [],
    symbol: prev?.symbol,
    tf_minutes: prev?.tf_minutes,
    volume: prev?.volume,
    runs: results.length,
    results,
    best: results[0] ?? null,
  }
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

/**
 * Match Optimize "view filter": keep trades by entry hour / DOW, rebuild equity + stats.
 * Does NOT re-simulate the strategy (engine hour masks change path dependence).
 */
function filterBacktestLikeOptimizeView(
  bt: BacktestResult,
  hoursCsv?: string,
  dowCsv?: string,
): BacktestResult {
  const hourSet =
    hoursCsv && hoursCsv.trim()
      ? new Set(
          hoursCsv
            .split(',')
            .map((x) => Number(x.trim()))
            .filter((n) => Number.isFinite(n)),
        )
      : null
  const daySet =
    dowCsv && dowCsv.trim()
      ? new Set(
          dowCsv
            .split(',')
            .map((x) => x.trim().toLowerCase())
            .filter(Boolean),
        )
      : null
  if (!hourSet && !daySet) return bt

  const trades = bt.trades.filter((t: TradeRow) => {
    if (daySet && !daySet.has(istDow(t.entry_time))) return false
    if (hourSet && !hourSet.has(istHour(t.entry_time))) return false
    return true
  })
  let run = 0
  const equity =
    trades.length > 0
      ? trades.map((t) => {
          run += Number(t.pnl) || 0
          return { time: t.exit_time, equity: run }
        })
      : [{ time: bt.equity[0]?.time || new Date().toISOString(), equity: 0 }]
  const wins = trades.filter((t) => Number(t.pnl) > 0).length
  return {
    ...bt,
    trades,
    equity,
    stats: {
      ...bt.stats,
      trades: trades.length,
      net_pnl: run,
      win_rate: trades.length ? (100 * wins) / trades.length : 0,
    },
  }
}

const DEFAULTS: StrategyParams = {
  exchange: 'BINANCE_UM',
  symbol: 'ETHUSDT',
  tf: 15,
  wait_and_trade: false,
  pro_mode: false,
  pro_mtf_mode: false,
  base_tf: 15,
  base_threshold: 30,
  pro_vwap_sigma: 2,
  rr: 1,
  sl_tp_unit: 'range',
  sl_on: 1,
  tp_on: 1,
  sl_unit: 'range',
  tp_unit: 'range',
  stop_loss: 50,
  take_profit: 100,
  risk_on: 1,
  trail_stop: 0,
  trail_unit: 'range',
  trail_value: 50,
  volume: 0.01,
  threshold: 50,
  entry_after: 330,
  entry_before: 1260,
  exit_time: 1260,
  trade_mode: 2,
  slippage_pct: 0.005,
  fee_pct: 0.05,
  time_stop_minutes: 0, // always off — TStop UI removed
  re_entry: 0,
  stop_to_be: 0,
  break_even: 0,
  break_even_pct: 50,
  be_unit: 'range',
  be_value: 50,
  be_ctc: 2,
  start: '2026-08-01',
  end: '2026-08-03',
}

export default function App() {
  const [step, setStep] = useState<Step>(1)
  const [params, setParams] = useState<StrategyParams>(() => ({
    ...DEFAULTS,
    ...loadSavedParams(),
  }))
  const [availability, setAvailability] = useState<DataAvailability | null>(null)
  const [data, setData] = useState<BacktestResult | null>(null)
  const [opt, setOpt] = useState<OptimizeResult | null>(null)
  const [health, setHealth] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sessionStarted, setSessionStarted] = useState(false)
  const [ofVisited, setOfVisited] = useState(false)
  const [view, setView] = useState<'charts' | 'trades' | 'equity' | 'performance'>('charts')
  const [optProgress, setOptProgress] = useState<{
    done: number
    total: number
    workers?: number
  } | null>(null)
  const reqId = useRef(0)
  const optAbortRef = useRef<AbortController | null>(null)

  const dataReady = Boolean(availability?.ready)

  useEffect(() => {
    saveSavedParams(params)
  }, [params])

  useEffect(() => {
    void fetchHealth()
      .then(setHealth)
      .catch(() => undefined)
    // restore readiness if parquet already present
    void fetchDataStatus({
      exchange: params.exchange,
      symbol: params.symbol,
      start: params.start,
      end: params.end,
      tf: params.tf,
    })
      .then(setAvailability)
      .catch(() => undefined)
  }, [])

  const onLoadData = async () => {
    setBusy(true)
    setErr(null)
    setSessionStarted(false)
    setData(null)
    try {
      const res = await loadData({
        exchange: params.exchange,
        symbol: params.symbol,
        start: params.start,
        end: params.end,
        tf: params.tf,
      })
      setAvailability(res.availability)
      if (res.availability.ready) setStep(2)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const runBacktest = useCallback(async (p: StrategyParams) => {
    const id = ++reqId.current
    setBusy(true)
    setErr(null)
    try {
      const bt = await fetchBacktest(p)
      if (id !== reqId.current) return undefined
      clearChartRange()
      resetChartStudy()
      setData(bt)
      if (bt.availability) setAvailability(bt.availability)
      setSessionStarted(true)
      return bt
    } catch (e) {
      if (id !== reqId.current) return undefined
      setErr(String(e))
      throw e
    } finally {
      if (id === reqId.current) setBusy(false)
    }
  }, [])

  const runOptimize = async (grid: OptimizeGrid) => {
    optAbortRef.current?.abort()
    const ac = new AbortController()
    optAbortRef.current = ac
    setBusy(true)
    setErr(null)
    setOptProgress({ done: 0, total: 0 })
    setOpt({
      runs: 0,
      rank_by: grid.rank_by,
      best: null,
      results: [],
      metric_columns: [],
      symbol: grid.symbol || params.symbol,
      start: grid.start || params.start,
      end: grid.end || params.end,
      tf_minutes: grid.tf,
      volume: params.volume,
    })
    try {
      const result = await fetchOptimize(
        {
          exchange: params.exchange,
          volume: params.volume,
          slippage_pct: params.slippage_pct,
          fee_pct: params.fee_pct,
          max_runs: 400,
          ...grid,
          symbol: grid.symbol || params.symbol,
          start: grid.start || params.start,
          end: grid.end || params.end,
          tf: grid.tf,
        },
        (done, total, workers, combo) => {
          setOptProgress({ done, total, workers })
          if (combo) {
            setOpt((prev) => mergeLiveOpt(prev, combo, grid.rank_by))
          }
        },
        ac.signal,
      )
      if (ac.signal.aborted) return
      setOpt({
        ...result,
        symbol: result.symbol || grid.symbol,
        start: grid.start,
        end: grid.end,
      })
    } catch (e) {
      if (e instanceof OptimizeCancelledError || ac.signal.aborted) {
        // keep last progress briefly cleared; no error toast
      } else {
        setErr(String(e))
      }
    } finally {
      if (optAbortRef.current === ac) optAbortRef.current = null
      setBusy(false)
      setOptProgress(null)
    }
  }

  const stopOptimize = () => {
    optAbortRef.current?.abort()
  }

  const applyBest = () => {
    if (!opt?.best) return
    applyCombo(opt.best)
  }

  const [applyNote, setApplyNote] = useState<string | null>(null)

  const applyCombo = (
    b: OptimizePoint,
    viewFilter?: { dayofweek?: string; allowed_entry_hours?: string },
  ) => {
    // Apply writes params then runs once. Backtest tab does not auto-run on edits.
    const dowFromOpt =
      typeof opt?.dayofweek === 'string' && opt.dayofweek.trim()
        ? opt.dayofweek.trim()
        : undefined
    // View DOW filter for post-filter; engine dayofweek only when optimize used common.
    const viewDow = viewFilter?.dayofweek?.trim() || undefined
    const hours = viewFilter?.allowed_entry_hours?.trim() || undefined
    const slOn = Number(
      (b as { sl_on?: number }).sl_on ?? (b as { risk_on?: number }).risk_on ?? params.sl_on ?? 1,
    )
      ? 1
      : 0
    const tpOn = Number(
      (b as { tp_on?: number }).tp_on ?? (b as { risk_on?: number }).risk_on ?? params.tp_on ?? 1,
    )
      ? 1
      : 0
    const next: StrategyParams = {
      ...params,
      symbol: String(opt?.symbol || params.symbol),
      start: String(opt?.start || params.start),
      end: String(opt?.end || params.end),
      tf: Number(opt?.tf_minutes ?? params.tf),
      threshold: Number(b.threshold),
      rr: Number(b.rr),
      wait_and_trade: Boolean(b.wait_and_trade) && !Boolean(b.pro_mtf_mode),
      pro_mode: Boolean((b as { pro_mode?: boolean | number }).pro_mode) && !Boolean(b.pro_mtf_mode),
      pro_mtf_mode: Boolean(b.pro_mtf_mode),
      base_tf: Number(b.base_tf || params.base_tf || 15),
      base_threshold: Number(
        b.base_threshold || params.base_threshold || 30,
      ),
      pro_vwap_sigma: (() => {
        const n = Number(
          (b as { pro_vwap_sigma?: number }).pro_vwap_sigma ?? params.pro_vwap_sigma ?? 2,
        )
        return n === 1 || n === 3 ? n : 2
      })(),
      re_entry: 0,
      stop_to_be: 0,
      break_even: Number(b.break_even ?? 0) ? 1 : 0,
      break_even_pct: Number(b.break_even_pct ?? params.break_even_pct ?? 50),
      be_unit: (['range', 'tick', 'points', 'pct'].includes(
        String((b as { be_unit?: string }).be_unit || params.be_unit),
      )
        ? String((b as { be_unit?: string }).be_unit || params.be_unit)
        : params.be_unit) as StrategyParams['be_unit'],
      be_value: Number((b as { be_value?: number }).be_value ?? params.be_value ?? 50),
      be_ctc: Number((b as { be_ctc?: number }).be_ctc ?? params.be_ctc ?? 2),
      slippage_pct: Number(b.slippage_pct ?? params.slippage_pct ?? 0),
      fee_pct: Number(b.fee_pct ?? params.fee_pct ?? 0),
      entry_after: Number(b.entry_after ?? opt?.entry_after ?? params.entry_after),
      entry_before: Number(b.entry_before ?? opt?.entry_before ?? params.entry_before),
      exit_time: Number(b.exit_time ?? opt?.exit_time ?? params.exit_time),
      time_stop_minutes: 0,
      trade_mode: Number(params.trade_mode ?? 2),
      volume: Number((b as { volume?: number }).volume ?? params.volume),
      sl_tp_unit: (['range', 'tick', 'points', 'pct'].includes(
        String((b as { sl_tp_unit?: string }).sl_tp_unit || params.sl_tp_unit),
      )
        ? String((b as { sl_tp_unit?: string }).sl_tp_unit || params.sl_tp_unit)
        : params.sl_tp_unit) as StrategyParams['sl_tp_unit'],
      sl_unit: (['range', 'tick', 'points', 'pct'].includes(
        String((b as { sl_unit?: string }).sl_unit || (b as { sl_tp_unit?: string }).sl_tp_unit || params.sl_unit),
      )
        ? String((b as { sl_unit?: string }).sl_unit || (b as { sl_tp_unit?: string }).sl_tp_unit || params.sl_unit)
        : params.sl_unit) as StrategyParams['sl_unit'],
      tp_unit: (['range', 'tick', 'points', 'pct'].includes(
        String((b as { tp_unit?: string }).tp_unit || (b as { sl_tp_unit?: string }).sl_tp_unit || params.tp_unit),
      )
        ? String((b as { tp_unit?: string }).tp_unit || (b as { sl_tp_unit?: string }).sl_tp_unit || params.tp_unit)
        : params.tp_unit) as StrategyParams['tp_unit'],
      stop_loss: Number(
        (b as { stop_loss?: number }).stop_loss ?? params.stop_loss ?? 50,
      ),
      take_profit: Number(
        (b as { take_profit?: number }).take_profit ?? params.take_profit ?? 100,
      ),
      trail_stop: Number((b as { trail_stop?: number }).trail_stop ?? 0) ? 1 : 0,
      sl_on: slOn,
      tp_on: tpOn,
      risk_on: slOn || tpOn ? 1 : 0,
      trail_unit: (['range', 'tick', 'points', 'pct'].includes(
        String((b as { trail_unit?: string }).trail_unit || params.trail_unit),
      )
        ? String((b as { trail_unit?: string }).trail_unit || params.trail_unit)
        : params.trail_unit) as StrategyParams['trail_unit'],
      trail_value: Number(
        (b as { trail_value?: number }).trail_value ?? params.trail_value ?? 50,
      ),
      // Engine session = optimize common DOW only (not view hour mask — that is post-filter).
      dayofweek: opt?.common_optimizer ? dowFromOpt : undefined,
      allowed_entry_hours: undefined,
    }
    const beLab = next.break_even
      ? next.be_unit === 'range'
        ? `BE On Range CTC ${next.be_ctc}`
        : next.be_unit === 'pct'
          ? `BE On ${next.be_value}% CTC ${next.be_ctc}`
          : `BE On ${next.be_value} ${next.be_unit} CTC ${next.be_ctc}`
      : 'BE Off'
    const expectTrades = Number(b.trades ?? 0)
    const expectNet = Number(b.net_pnl ?? 0)
    const filterNote = hours
      ? ` · view entry hours ${hours}${viewDow ? ` · days ${viewDow}` : ''}`
      : viewDow
        ? ` · view days ${viewDow}`
        : ''
    setApplyNote(
      `Applied thr=${next.threshold} RR=${next.rr} ${beLab}${filterNote} · optimize cell trades=${expectTrades} net=${expectNet.toFixed(2)} → running backtest…`,
    )
    setParams(next)
    setView('performance')
    setStep(2)
    setSessionStarted(true)
    void runBacktest(next)
      .then((bt) => {
        if (!bt) return
        const filtered = filterBacktestLikeOptimizeView(bt, hours, viewDow)
        setData(filtered)
        const gotTrades = Number(filtered.stats?.trades ?? 0)
        const gotNet = Number(filtered.stats?.net_pnl ?? 0)
        const cellMismatch =
          !hours &&
          !viewDow &&
          expectTrades > 0 &&
          (gotTrades !== expectTrades || Math.abs(gotNet - expectNet) > 0.02)
        setApplyNote(
          hours || viewDow
            ? `Applied thr=${next.threshold} RR=${next.rr} ${beLab}${filterNote} · view-filtered trades=${gotTrades} net=${gotNet.toFixed(2)} (same rule as Optimize hour filter).`
            : cellMismatch
              ? `Applied thr=${next.threshold} RR=${next.rr} ${beLab} · backtest trades=${gotTrades} net=${gotNet.toFixed(2)} (optimize cell was ${expectTrades} / ${expectNet.toFixed(2)}).`
              : `Applied thr=${next.threshold} RR=${next.rr} ${beLab} · backtest ready — trades=${gotTrades} net=${gotNet.toFixed(2)} (matches optimize cell).`,
        )
        window.setTimeout(() => setApplyNote(null), 9000)
      })
      .catch(() => {
        setApplyNote(`Apply failed for thr=${next.threshold} RR=${next.rr}.`)
        window.setTimeout(() => setApplyNote(null), 6000)
      })
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <h1>
            cursor_backtest <span className="ver">v{String(health?.version || '1.2.1')}</span>
          </h1>
          <span className={`badge ${dataReady ? 'ok' : ''}`}>
            {dataReady ? 'DATA READY' : 'DATA PENDING'}
          </span>
          <span
            className={`badge ${
              data?.parity_ok === true ? 'ok' : data?.parity_ok === false ? 'fail' : ''
            }`}
          >
            {!data
              ? 'idle'
              : data.parity_ok === true
                ? 'PARITY OK'
                : data.parity_ok === false
                  ? 'PARITY FAIL'
                  : 'PARITY N/A'}
          </span>
          {busy && <span className="badge">working…</span>}
        </div>
      </header>

      <nav className="stepper">
        {(
          [
            [1, '1. Data Loader'],
            [2, '2. Backtest'],
            [3, '3. Optimize'],
            [4, '4. Orderflow'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={`${step === id ? 'active' : ''} ${
              id === 1 && dataReady ? 'ready' : ''
            } ${id > 1 && dataReady ? 'ready' : ''}`}
            disabled={id > 1 && id !== 4 && !dataReady}
            onClick={() => {
              if (id === 4) setOfVisited(true)
              setStep(id)
            }}
          >
            {label}
            {id === 1 && dataReady ? ' ✓' : ''}
          </button>
        ))}
      </nav>

      {err && <div className="error">{err}</div>}
      {applyNote && <div className="apply-note">{applyNote}</div>}

      <div className="step-body">
        {step === 1 && (
          <DataLoaderStep
            exchange={params.exchange}
            symbol={params.symbol}
            start={params.start}
            end={params.end}
            tf={params.tf}
            busy={busy}
            dataReady={dataReady}
            onChange={(patch) => setParams((p) => ({ ...p, ...patch }))}
            onLoad={() => void onLoadData()}
          />
        )}
        {/* Keep Backtest mounted when on Optimize so chart zoom survives step switches */}
        {(step === 2 || (step === 3 && sessionStarted)) && (
          <div
            className="step-keep"
            style={{ display: step === 2 ? undefined : 'none', height: step === 2 ? '100%' : 0 }}
          >
            <BacktestStep
              params={params}
              onParams={setParams}
              data={data}
              busy={busy}
              sessionStarted={sessionStarted}
              onRun={() => void runBacktest(params)}
              onGoOptimize={() => setStep(3)}
              view={view}
              onView={setView}
            />
          </div>
        )}
        {step === 3 && (
          <OptimizeTab
            result={opt}
            busy={busy}
            dataReady={dataReady}
            progress={optProgress}
            defaultTf={params.tf}
            defaultEntryAfter={params.entry_after}
            defaultEntryBefore={params.entry_before}
            defaultExitTime={params.exit_time}
            defaultSlip={params.slippage_pct}
            defaultFee={params.fee_pct}
            defaults={params}
            onRun={runOptimize}
            onStop={stopOptimize}
            onApplyBest={applyBest}
            onLoadCombo={applyCombo}
          />
        )}
        {(step === 4 || ofVisited) && (
          <div
            className="of-keep"
            style={{ display: step === 4 ? undefined : 'none', height: step === 4 ? '100%' : 0, overflow: 'hidden' }}
          >
            <OrderflowTab
              exchange={params.exchange}
              symbol={params.symbol}
              start={params.start}
              end={params.end}
              tf={params.tf}
              dataReady={dataReady}
              active={step === 4}
            />
          </div>
        )}
      </div>
    </div>
  )
}
