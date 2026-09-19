export type StrategyParams = {
  exchange: string
  symbol: string
  tf: number
  wait_and_trade: boolean
  /** Pro: Lo/Sh/Se/Co + VWAP±Nσ qualifier (Directional-style entries). */
  pro_mode: boolean
  /** Pro-MTF: HTF AGGR line + LTF both-side whole-candle entries (no VWAP). */
  pro_mtf_mode: boolean
  /** Pro-MTF base (higher) timeframe minutes. */
  base_tf: number
  /** Pro-MTF base TF AGGR threshold %. */
  base_threshold: number
  /** Pro VWAP Nσ: whole candle above +Nσ or below −Nσ (1, 2, or 3). */
  pro_vwap_sigma: number
  rr: number
  /** Legacy shared SL/TP unit; used if sl_unit/tp_unit omitted. */
  sl_tp_unit: 'range' | 'tick' | 'points' | 'pct'
  /** Stop on/off (LSL/SSL). Independent of Target. */
  sl_on: number
  /** Target on/off (LT/ST). Independent of Stop. */
  tp_on: number
  sl_unit: 'range' | 'tick' | 'points' | 'pct'
  tp_unit: 'range' | 'tick' | 'points' | 'pct'
  /** Stop distance when SL unit is tick / points / pct */
  stop_loss: number
  /** Target distance when TP unit is tick / points / pct */
  take_profit: number
  /** Legacy: 1 if SL or TP on. */
  risk_on: number
  /** 1 = trail stop as price moves favorably */
  trail_stop: number
  /** Trail distance unit (independent of Risk). Range = AGGR gap. */
  trail_unit: 'range' | 'tick' | 'points' | 'pct'
  /** Trail distance when unit is tick / points / pct */
  trail_value: number
  volume: number
  threshold: number
  entry_after: number
  entry_before: number
  exit_time: number
  trade_mode: number
  /** Slippage as % of price on both fills (long entry + / exit −; short opposite). */
  slippage_pct: number
  /** Fee as % of slipped notional on both legs (entry + exit = 2 × avg). */
  fee_pct: number
  /** Max minutes in trade before market scratch (0 = off). */
  time_stop_minutes: number
  /** After SSL/LSL in WaitAndTrade ORB: 1 = re-enter if price returns to entry; 0 = off. */
  re_entry: number
  /** Same-side AGGR while in profit and through cost BE: add one more `volume` lot (max 3). */
  scale_in: number
  /** 1 = move stop to new AGGR extreme only if past entry (BE+); 0 = always tighten. */
  stop_to_be: number
  /** 1 = BreakEven on; 0 = off. */
  break_even: number
  /** Legacy lock % (ignored). Range locks 50% of R; % mode uses be_value. */
  break_even_pct: number
  /** Range/% = old 1R arm. Tick/Points = arm at be_value. */
  be_unit: 'range' | 'tick' | 'points' | 'pct'
  /** % = old BE% lock of R. Tick/Points = arm distance. Unused for Range. */
  be_value: number
  /** Cost-to-cover multiplier. Lock = (slip USDT + fee USDT) × CTC / lots. */
  be_ctc: number
  start: string
  end: string
  /** Optional IST weekday filter for parity with optimize common filters. */
  dayofweek?: string
  /** Optional CSV of IST entry hours 0–23 from heatmap filter, e.g. "8,9,11,15,20". */
  allowed_entry_hours?: string
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

export type MtfBiasRow = {
  time: string
  mode: 'bull' | 'bear' | string
  invalid: number
}

export type BacktestResult = {
  symbol: string
  tf_minutes: number
  wait_and_trade: boolean
  pro_mode?: number | boolean
  pro_mtf_mode?: number | boolean
  base_tf_minutes?: number
  base_threshold?: number
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
  /** Pro-MTF: HTF bias + invalidator timeline (active from bar close). */
  mtf_bias?: MtfBiasRow[]
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
  /** First tick that printed the running MFE extreme. */
  mfe_time?: string | null
  /** First tick that printed the running MAE extreme. */
  mae_time?: string | null
  /** Position size in lots (grows when Scale-in adds). */
  lots?: number
  /** Extra same-side adds after the first fill. */
  scale_n?: number
  /** Each scale-in fill (IST time, slipped price, added lots). */
  scale_fills?: { time: string; price: number; lots: number }[] | null
  /** Realized slippage cost (quote). */
  slippage?: number
  /** Realized fees (quote). */
  fee?: number
  /** LE / SE / LR / SR */
  entry_tag?: string
  /** Directional BreakEven moved stop to 0.5R lock */
  be_moved?: boolean
  /** BE arm price (1R / typed distance). */
  be_arm?: number | null
  /** BE lock price after arm is touched. */
  be_lock?: number | null
  /** First time the lock was applied. */
  be_moved_time?: string | null
  /** Initial stop at entry (before trail / BE). */
  stop_init?: number
  /** Trail staircase when Trail is on. */
  trail_path?: { time: string; stop: number }[] | null
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
  pro_tag?: string
  vwap_ok?: boolean
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
  start?: string
  end?: string
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

export type OptimizeTradeLite = {
  side: string
  signal_time?: string
  entry_time: string
  exit_time?: string
  entry_price?: number
  exit_price?: number
  stop?: number
  target?: number
  pnl: number
  mfe?: number
  mae?: number
  mfe_time?: string | null
  mae_time?: string | null
  slippage?: number
  fee?: number
  entry_tag?: string
  exit_reason?: string
  be_moved?: boolean
  signal_delta_pct?: number
  range?: number
}

export type OptimizePoint = {
  threshold: number
  rr: number
  wait_and_trade: boolean
  pro_mode?: number | boolean
  pro_mtf_mode?: number | boolean
  base_tf?: number
  base_threshold?: number
  pro_vwap_sigma?: number
  re_entry?: number
  stop_to_be?: number
  break_even?: number
  break_even_pct?: number
  sl_tp_unit?: string
  sl_on?: number
  tp_on?: number
  sl_unit?: string
  tp_unit?: string
  stop_loss?: number
  take_profit?: number
  trail_stop?: number
  risk_on?: number
  trail_unit?: string
  trail_value?: number
  be_unit?: string
  be_value?: number
  be_ctc?: number
  volume?: number
  trades: number
  entry_tags?: Record<string, number>
  scale_in?: number
  scale_adds?: number
  net_pnl: number
  /** Fill gross = Net + Fees (slip already in Entry/Exit). */
  gross_pnl?: number
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
  avg_ttmfe?: number
  avg_ttmae?: number
  avg_dt?: number
  pct_mae_first?: number
  pct_mfe_first?: number
  pct_premature?: number
  pct_giveback?: number
  pct_momentum?: number
  ulcer_index?: number
  kelly_fraction?: number
  total_slippage?: number
  total_fees?: number
  total_cost?: number
  slippage_pct?: number
  fee_pct?: number
  entry_after?: number
  entry_before?: number
  exit_time?: number
  time_stop_minutes?: number
  entry_hours?: Record<string, number>
  /** Downsampled cumulative PnL for leaderboard mini equity charts */
  equity_spark?: number[]
  /** Lite trades for per-row CSV detail export */
  trades_lite?: OptimizeTradeLite[]
  exits: Record<string, number>
  [key: string]:
    | number
    | boolean
    | string
    | number[]
    | Record<string, number>
    | OptimizeTradeLite[]
    | undefined
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
  return r.json() as Promise<{
    count: number
    total?: number
    bars: OhlcvBar[]
    tf: number
    symbol: string
  }>
}

export type OrderflowBar = {
  time: number
  time_iso: string
  open: number
  high: number
  low: number
  close: number
  volume_quote: number
  volume_base: number
  delta_quote: number
  delta_base: number
  delta_pct: number
  range?: number | null
  rangeMid?: number | null
  rangeUpper?: number | null
  volMidQuote?: number | null
  volStdQuote?: number | null
  volMidBase?: number | null
  volStdBase?: number | null
  dAbsMidQuote?: number | null
  dAbsStdQuote?: number | null
  dAbsMidBase?: number | null
  dAbsStdBase?: number | null
  hh?: boolean
  ll?: boolean
}

export async function fetchOrderflowBars(p: {
  exchange: string
  symbol: string
  tf: number
  start: string
  end: string
}) {
  const r = await fetch(`/api/orderflow/bars?${qs(p)}`)
  if (!r.ok) throw new Error(await errText(r))
  return r.json() as Promise<{
    count: number
    total?: number
    bars: OrderflowBar[]
    tf: number
    symbol: string
    start: string
    end: string
  }>
}

export type FootprintLevel = {
  price: number
  bidVolume: number
  askVolume: number
  bidQuote: number
  askQuote: number
  tradeCount: number
}

export type FootprintBar = {
  time: number
  open: number
  high: number
  low: number
  close: number
  bidQuote?: number
  askQuote?: number
  poc?: number
  val?: number
  vah?: number
  pocBase?: number
  valBase?: number
  vahBase?: number
  minDelta?: number
  maxDelta?: number
  minDeltaQuote?: number
  maxDeltaQuote?: number
  cotHigh?: number
  cotLow?: number
  cotHighQuote?: number
  cotLowQuote?: number
  levels?: FootprintLevel[]
}

export type FootprintResponse = {
  ok: boolean
  reason?: string
  tick_size: number
  symbol_tick?: number
  bin_mult?: number
  tf: number
  max_bars?: number
  requested_bars?: number
  count?: number
  bars: FootprintBar[]
}

export async function fetchFootprint(
  p: { symbol: string; tf: number; t0: number; t1: number; bin_mult?: number; max_bars?: number },
  signal?: AbortSignal,
) {
  const r = await fetch(`/api/footprint?${qs(p)}`, { signal })
  if (!r.ok) throw new Error(await errText(r))
  return (await r.json()) as FootprintResponse
}

export type AnchoredProfile = {
  ok: boolean
  reason?: string
  tick_size: number
  bin_mult?: number
  poc?: number | null
  val?: number | null
  vah?: number | null
  pocBase?: number | null
  valBase?: number | null
  vahBase?: number | null
  levels: FootprintLevel[]
}

export async function fetchAnchoredProfile(
  p: { symbol: string; tf: number; t0: number; t1: number; bin_mult?: number },
  signal?: AbortSignal,
) {
  const r = await fetch(`/api/anchored-profile?${qs(p)}`, { signal })
  if (!r.ok) throw new Error(await errText(r))
  return (await r.json()) as AnchoredProfile
}

export async function fetchAnchoredProfiles(
  p: {
    symbol: string
    tf: number
    bin_mult?: number
    ranges: { t0: number; t1: number }[]
  },
  signal?: AbortSignal,
) {
  const r = await fetch('/api/anchored-profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
    signal,
  })
  if (!r.ok) throw new Error(await errText(r))
  return (await r.json()) as { ok: boolean; tick_size?: number; profiles: AnchoredProfile[] }
}

export async function fetchValueArea(
  p: { symbol: string; tf: number; t0: number; t1: number; bin_mult?: number },
  signal?: AbortSignal,
) {
  const r = await fetch(`/api/value-area?${qs(p)}`, { signal })
  if (!r.ok) throw new Error(await errText(r))
  return (await r.json()) as FootprintResponse
}

export async function fetchFlowStats(
  p: { symbol: string; tf: number; t0: number; t1: number; max_bars?: number },
  signal?: AbortSignal,
) {
  const r = await fetch(`/api/flow-stats?${qs(p)}`, { signal })
  if (!r.ok) throw new Error(await errText(r))
  return (await r.json()) as FootprintResponse
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
    pro_vwap_sigma?: number
    pro_vwap_sigmas?: string
    re_entry_flags?: string
    stop_to_be_flags?: string
    break_even_flags?: string
    break_even_pcts?: string
    sl_tp_unit?: string
    sl_unit?: string
    tp_unit?: string
    stop_losses?: string
    take_profits?: string
    trail_stop_flags?: string
    risk_on_flags?: string
    sl_on_flags?: string
    tp_on_flags?: string
    trail_unit?: string
    trail_value?: number
    trail_values?: string
    be_unit?: string
    be_value?: number
    be_values?: string
    be_ctc?: number
    volumes?: string
    base_tfs?: string
    base_thresholds?: string
    max_runs?: number
    workers?: number
  },
  onProgress?: (
    done: number,
    total: number,
    workers?: number,
    combo?: OptimizePoint,
  ) => void,
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
          row?: OptimizePoint
          message?: string
        }
        if (ev.type === 'progress' && onProgress) {
          onProgress(Number(ev.done || 0), Number(ev.total || 0), ev.workers)
        } else if (ev.type === 'combo') {
          if (onProgress) {
            onProgress(Number(ev.done || 0), Number(ev.total || 0), ev.workers, ev.row)
          }
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
