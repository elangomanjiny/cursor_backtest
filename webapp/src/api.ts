export type StrategyParams = {
  exchange: string
  symbol: string
  tf: number
  wait_and_trade: boolean
  rr: number
  volume: number
  threshold: number
  entry_after: number
  entry_before: number
  exit_time: number
  trade_mode: number
  /** Slippage as % of price (worsens fills). */
  slippage_pct: number
  /** Fee as % of notional per side (entry + exit). */
  fee_pct: number
  /** Max minutes in trade before market scratch (0 = off). */
  time_stop_minutes: number
  /** After SSL/LSL in WaitAndTrade ORB: 1 = re-enter if price returns to entry; 0 = off. */
  re_entry: number
  /** 1 = move stop to new AGGR extreme only if past entry (BE+); 0 = always tighten. */
  stop_to_be: number
  /** Directional only: 1 = arm at 1R → lock stop at BE% of R once; 0 = off. */
  break_even: number
  /** BreakEven lock as % of range (default 50 → 0.5×R from entry). */
  break_even_pct: number
  start: string
  end: string
}

export type DataAvailability = {
  ready: boolean
  exchange: string
  symbol: string
  tf: number
  start: string
  end: string
  bars_in_range: number
  first_bar?: string | null
  last_bar?: string | null
  checks: { id: string; label: string; ok: boolean; detail: string }[]
  manifest?: Record<string, unknown> | null
}

export type OhlcvBar = {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume_quote: number
  volume_base: number
  delta_quote: number
  delta_base: number
  delta_pct: number
}

export type BacktestStats = {
  trades: number
  aggressive: number
  net_pnl: number
  win_rate: number
  exits?: Record<string, number>
  profit_factor?: number
  expectancy?: number
  sharpe?: number
  sortino?: number
  max_drawdown?: number
  calmar?: number
  recovery_factor?: number
  payoff_ratio?: number
  [key: string]: number | Record<string, number> | undefined
}

export type BacktestResult = {
  symbol: string
  tf_minutes: number
  wait_and_trade: boolean
  rr: number
  volume: number
  threshold: number
  re_entry?: number
  stop_to_be?: number
  break_even?: number
  break_even_pct?: number
  stats: BacktestStats
  trades: TradeRow[]
  aggressive: AggressiveRow[]
  bars: BarRow[]
  equity: { time: string; equity: number }[]
  parity_ok?: boolean | null
  parity_checked?: boolean
  parity_errors?: string[]
  engine?: string
  params?: StrategyParams
  availability?: DataAvailability
}

export type TradeRow = {
  side: string
  entry_time: string
  exit_time: string
  entry_price: number
  exit_price: number
  exit_reason: string
  pnl: number
  stop: number
  target: number
  signal_time: string
  signal_high: number
  signal_low: number
  signal_delta_pct: number
  range: number
  mfe?: number
  mae?: number
  /** Realized slippage cost (quote). */
  slippage?: number
  /** Realized fees (quote). */
  fee?: number
  /** LE / SE / LR / SR */
  entry_tag?: string
  /** Directional BreakEven moved stop to 0.5R lock */
  be_moved?: boolean
}

export type AggressiveRow = {
  time: string
  side: string
  open?: number
  high: number
  low: number
  close?: number
  volume_usdt?: number
  delta_usdt?: number
  delta_pct: number
  range: number
}

export type BarRow = {
  time: number
  time_iso: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  delta: number
  volume_quote?: number
  delta_quote?: number
  volume_base?: number
  delta_base?: number
  delta_pct: number
  events: string[]
}

export type OptimizeResult = {
  runs: number
  rank_by: string
  symbol?: string
  tf_minutes?: number
  volume?: number
  common_optimizer?: boolean
  time_optimizer?: boolean
  time_step_minutes?: number | null
  timewindow?: string | null
  dayofweek?: string | null
  min_trades?: number
  min_trades_eligible?: number
  time_stop_minutes?: number
  workers?: number
  entry_after?: number
  entry_before?: number
  exit_time?: number
  bars_used?: number
  truncated?: boolean
  slippage_pct?: number
  fee_pct?: number
  entry_hour_heatmap?: Record<string, number> | null
  /** Compact trades for best combo — used for client-side DOW/hour analysis filters */
  best_trades?: { entry_time: string; pnl: number; side?: string; exit_reason?: string }[] | null
  best: OptimizePoint | null
  results: OptimizePoint[]
  metric_columns: string[]
  engine?: string
}

export type OptimizePoint = {
  threshold: number
  rr: number
  wait_and_trade: boolean
  re_entry?: number
  stop_to_be?: number
  break_even?: number
  break_even_pct?: number
  trades: number
  entry_tags?: Record<string, number>
  net_pnl: number
  win_rate: number
  sharpe: number
  sortino: number
  profit_factor: number
  expectancy: number
  max_drawdown: number
  calmar: number
  recovery_factor: number
  payoff_ratio: number
  avg_win: number
  avg_loss: number
  max_consec_wins: number
  max_consec_losses: number
  sqn?: number
  e_ratio?: number
  avg_mfe?: number
  avg_mae?: number
  ulcer_index?: number
  kelly_fraction?: number
  total_slippage?: number
  total_fees?: number
  slippage_pct?: number
  fee_pct?: number
  entry_after?: number
  entry_before?: number
  exit_time?: number
  time_stop_minutes?: number
  entry_hours?: Record<string, number>
  exits: Record<string, number>
  [key: string]: number | boolean | Record<string, number> | undefined
}

const qs = (params: Record<string, string | number | boolean | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')

async function errText(r: Response): Promise<string> {
  const text = await r.text()
  try {
    const j = JSON.parse(text)
    if (typeof j.detail === 'string') return j.detail
    if (j.detail?.message) return String(j.detail.message)
    return text
  } catch {
    return text
  }
}

export async function fetchHealth() {
  const r = await fetch('/api/health')
  if (!r.ok) throw new Error(await errText(r))
  return r.json()
}

export async function fetchDataStatus(p: {
  exchange: string
  symbol: string
  start: string
  end: string
  tf: number
}) {
  const r = await fetch(`/api/data/status?${qs(p)}`)
  if (!r.ok) throw new Error(await errText(r))
  return (await r.json()) as DataAvailability
}

export async function loadData(p: {
  exchange: string
  symbol: string
  start: string
  end: string
  tf: number
}) {
  const r = await fetch(`/api/data/load?${qs(p)}`, { method: 'POST' })
  if (!r.ok) throw new Error(await errText(r))
  return r.json() as Promise<{
    manifest: Record<string, unknown>
    availability: DataAvailability
  }>
}

export async function fetchBars(p: {
  symbol: string
  tf: number
  start: string
  end: string
}) {
  const r = await fetch(`/api/data/bars?${qs(p)}`)
  if (!r.ok) throw new Error(await errText(r))
  return r.json() as Promise<{ count: number; bars: OhlcvBar[]; tf: number; symbol: string }>
}

export async function fetchBacktest(params: StrategyParams) {
  const r = await fetch(`/api/backtest?${qs(params)}`)
  if (!r.ok) throw new Error(await errText(r))
  return (await r.json()) as BacktestResult
}

export type SystemResources = {
  ok: boolean
  warn_level?: 'ok' | 'amber' | 'red' | 'unknown'
  message?: string
  ram_used_bytes?: number
  ram_total_bytes?: number
  ram_available_bytes?: number
  ram_percent?: number | null
  cpu_percent?: number | null
  source?: string
}

export async function fetchSystemResources(signal?: AbortSignal) {
  const r = await fetch('/api/system/resources', { signal })
  if (!r.ok) throw new Error(await errText(r))
  return (await r.json()) as SystemResources
}

export class OptimizeCancelledError extends Error {
  constructor(message = 'Optimize cancelled') {
    super(message)
    this.name = 'OptimizeCancelledError'
  }
}

export async function fetchOptimize(
  params: Partial<StrategyParams> & {
    thresholds: string
    rrs: string
    wait_flags: string
    rank_by?: string
    common_optimizer?: boolean
    time_optimizer?: boolean
    time_step_minutes?: number
    timewindow?: string
    dayofweek?: string
    entry_after?: number
    entry_before?: number
    exit_time?: number
    entry_after_to?: number
    entry_before_to?: number
    exit_time_to?: number
    slippage_pcts?: string
    fee_pcts?: string
    min_trades?: number
    time_stop_minutes?: number
    re_entry_flags?: string
    stop_to_be_flags?: string
    break_even_flags?: string
    break_even_pcts?: string
    max_runs?: number
    workers?: number
  },
  onProgress?: (done: number, total: number, workers?: number) => void,
  signal?: AbortSignal,
) {
  const r = await fetch(`/api/optimize?${qs({ ...params, stream: true })}`, { signal })
  if (!r.ok) throw new Error(await errText(r))
  if (!r.body) throw new Error('Optimize stream unavailable')

  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let result: OptimizeResult | null = null

  try {
    while (true) {
      if (signal?.aborted) throw new OptimizeCancelledError()
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const ev = JSON.parse(line) as {
          type: string
          done?: number
          total?: number
          workers?: number
          payload?: OptimizeResult
          message?: string
        }
        if (ev.type === 'progress' && onProgress) {
          onProgress(Number(ev.done || 0), Number(ev.total || 0), ev.workers)
        } else if (ev.type === 'result' && ev.payload) {
          result = ev.payload
        } else if (ev.type === 'error') {
          throw new Error(ev.message || 'Optimize failed')
        }
      }
    }
  } catch (e) {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
    if (
      (e instanceof DOMException && e.name === 'AbortError') ||
      (e instanceof Error && e.name === 'AbortError') ||
      signal?.aborted
    ) {
      throw new OptimizeCancelledError()
    }
    throw e
  }
  if (!result) throw new Error('Optimize finished without a result')
  return result
}
