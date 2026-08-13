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
} from './api'
import { clearChartRange } from './chartZoomStore'
import { resetChartStudy } from './chartStudyStore'
import { BacktestStep } from './steps/BacktestStep'
import { DataLoaderStep } from './steps/DataLoaderStep'
import { OptimizeTab, type OptimizeGrid } from './tabs/OptimizeTab'
import './App.css'

type Step = 1 | 2 | 3

const DEFAULTS: StrategyParams = {
  exchange: 'BINANCE_UM',
  symbol: 'ETHUSDT',
  tf: 15,
  wait_and_trade: false,
  rr: 1,
  volume: 0.01,
  threshold: 50,
  entry_after: 330,
  entry_before: 1260,
  exit_time: 1260,
  trade_mode: 2,
  slippage_pct: 0,
  fee_pct: 0,
  time_stop_minutes: 0,
  re_entry: 0,
  stop_to_be: 0,
  break_even: 0,
  break_even_pct: 50,
  start: '2026-08-01',
  end: '2026-08-03',
}

export default function App() {
  const [step, setStep] = useState<Step>(1)
  const [params, setParams] = useState<StrategyParams>(DEFAULTS)
  const [availability, setAvailability] = useState<DataAvailability | null>(null)
  const [data, setData] = useState<BacktestResult | null>(null)
  const [opt, setOpt] = useState<OptimizeResult | null>(null)
  const [health, setHealth] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sessionStarted, setSessionStarted] = useState(false)
  const [view, setView] = useState<'charts' | 'trades' | 'equity'>('charts')
  const [optProgress, setOptProgress] = useState<{
    done: number
    total: number
    workers?: number
  } | null>(null)
  const reqId = useRef(0)
  const optAbortRef = useRef<AbortController | null>(null)

  const dataReady = Boolean(availability?.ready)

  useEffect(() => {
    void fetchHealth()
      .then(setHealth)
      .catch(() => undefined)
    // restore readiness if parquet already present
    void fetchDataStatus({
      exchange: DEFAULTS.exchange,
      symbol: DEFAULTS.symbol,
      start: DEFAULTS.start,
      end: DEFAULTS.end,
      tf: DEFAULTS.tf,
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
      if (id !== reqId.current) return
      clearChartRange()
      resetChartStudy()
      setData(bt)
      if (bt.availability) setAvailability(bt.availability)
      setSessionStarted(true)
    } catch (e) {
      if (id !== reqId.current) return
      setErr(String(e))
    } finally {
      if (id === reqId.current) setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!sessionStarted || step !== 2) return
    const t = window.setTimeout(() => {
      void runBacktest(params)
    }, 350)
    return () => window.clearTimeout(t)
  }, [params, sessionStarted, step, runBacktest])

  const runOptimize = async (grid: OptimizeGrid) => {
    optAbortRef.current?.abort()
    const ac = new AbortController()
    optAbortRef.current = ac
    setBusy(true)
    setErr(null)
    setOptProgress({ done: 0, total: 0 })
    try {
      const result = await fetchOptimize(
        {
          exchange: params.exchange,
          symbol: params.symbol,
          volume: params.volume,
          start: params.start,
          end: params.end,
          slippage_pct: params.slippage_pct,
          fee_pct: params.fee_pct,
          max_runs: 400,
          ...grid,
          tf: grid.tf,
        },
        (done, total, workers) => setOptProgress({ done, total, workers }),
        ac.signal,
      )
      if (ac.signal.aborted) return
      setOpt(result)
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

  const applyCombo = (b: OptimizePoint) => {
    setParams((p) => ({
      ...p,
      tf: Number(opt?.tf_minutes ?? p.tf),
      threshold: b.threshold,
      rr: b.rr,
      wait_and_trade: b.wait_and_trade,
      re_entry: 0,
      stop_to_be: 0,
      break_even: b.wait_and_trade ? 0 : Number(b.break_even ?? 0) ? 1 : 0,
      break_even_pct: Number(b.break_even_pct ?? p.break_even_pct ?? 50),
      slippage_pct: Number(b.slippage_pct ?? p.slippage_pct),
      fee_pct: Number(b.fee_pct ?? p.fee_pct),
      entry_after: Number(b.entry_after ?? opt?.entry_after ?? p.entry_after),
      entry_before: Number(b.entry_before ?? opt?.entry_before ?? p.entry_before),
      exit_time: Number(b.exit_time ?? opt?.exit_time ?? p.exit_time),
      time_stop_minutes: Number(
        b.time_stop_minutes ?? opt?.time_stop_minutes ?? p.time_stop_minutes,
      ),
    }))
    setView('equity')
    setStep(2)
    setSessionStarted(true)
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
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={`${step === id ? 'active' : ''} ${
              id === 1 && dataReady ? 'ready' : ''
            } ${id > 1 && dataReady ? 'ready' : ''}`}
            disabled={id > 1 && !dataReady}
            onClick={() => setStep(id)}
          >
            {label}
            {id === 1 && dataReady ? ' ✓' : ''}
          </button>
        ))}
      </nav>

      {err && <div className="error">{err}</div>}

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
            onRun={runOptimize}
            onStop={stopOptimize}
            onApplyBest={applyBest}
            onLoadCombo={applyCombo}
          />
        )}
      </div>
    </div>
  )
}
