import type { BacktestResult, TradeRow } from '../api'

export type EquityPoint = {
  time: number
  equity: number
  drawdownPct: number
  cumReturnPct: number
  peak: number
}

export type MarkerPoint = {
  time: number
  equity: number
  pnl: number
  win: boolean
  side: string
  kind: 'entry' | 'exit'
}

export type DashboardMetrics = {
  // Returns
  totalReturnPct: number
  cagrPct: number
  cumulativePnl: number
  // Risk-adjusted
  sharpe: number
  sortino: number
  calmar: number
  maxDrawdownPct: number
  maxDrawdownAbs: number
  maxDdDurationHours: number
  maxDdDurationDays: number
  maxDdDurationBars: number
  avgDrawdownPct: number
  recoveryFactor: number
  volatilityAnnPct: number
  // Trade stats
  winRate: number
  profitFactor: number
  expectancy: number
  avgWin: number
  avgLoss: number
  avgWinLossRatio: number
  totalTrades: number
  longTrades: number
  shortTrades: number
  avgTradeDurationHours: number
  avgWinDurationHours: number
  avgLossDurationHours: number
  avgTradePnl: number
  avgTradePnlPct: number
  largestWin: number
  largestLoss: number
  maxConsecWins: number
  maxConsecLosses: number
  avgMfe: number
  avgMae: number
  eRatio: number
  sqn: number
  // Exposure
  timeInMarketPct: number
  avgPositionSize: number
  turnover: number
  // Benchmark deltas
  bhTotalReturnPct: number
  excessReturnPct: number
  // Sparklines (normalized 0..1 samples)
  equitySpark: number[]
  ddSpark: number[]
  pnlSpark: number[]
  /** Raw equity values for mini charts (not normalized) */
  equityRawSpark: number[]
  ddRawSpark: number[]
}

export type MonthlyCell = {
  year: number
  month: number // 0-11
  returnPct: number
  trades: number
}

export type RecentTradeRow = {
  idx: number
  date: string
  symbol: string
  type: string
  pnl: number
  pnlPct: number
  durationHours: number
}

export type SideBucketStats = {
  trades: number
  netPnl: number
  winRate: number
  expectancy: number
  profitFactor: number
  avgPnl: number
  avgPnlPct: number
  avgDurationHours: number
  avgWinDurationHours: number
  avgLossDurationHours: number
  largestWin: number
  largestLoss: number
  winCount: number
  lossCount: number
  avgMfe: number
  avgMae: number
  eRatio: number
  sqn: number
  maxConsecWins: number
  maxConsecLosses: number
}

export type DashboardModel = {
  equity: EquityPoint[]
  buyHold: { time: number; value: number }[]
  markers: MarkerPoint[]
  metrics: DashboardMetrics
  startEquity: number
  monthlyReturns: MonthlyCell[]
  recentTrades: RecentTradeRow[]
  /** Per-step equity returns for RF-adjusted Sharpe */
  stepReturns: number[]
  stepsPerYear: number
  symbol: string
  bySide: {
    all: SideBucketStats
    long: SideBucketStats
    short: SideBucketStats
  }
  /** Full trade rows for Performance list (not capped at 5) */
  allTradeRows: RecentTradeRow[]
}

function emptySideStats(): SideBucketStats {
  return {
    trades: 0,
    netPnl: 0,
    winRate: 0,
    expectancy: 0,
    profitFactor: 0,
    avgPnl: 0,
    avgPnlPct: 0,
    avgDurationHours: 0,
    avgWinDurationHours: 0,
    avgLossDurationHours: 0,
    largestWin: 0,
    largestLoss: 0,
    winCount: 0,
    lossCount: 0,
    avgMfe: 0,
    avgMae: 0,
    eRatio: 0,
    sqn: 0,
    maxConsecWins: 0,
    maxConsecLosses: 0,
  }
}

function sqnFromPnls(pnls: number[]): number {
  const n = pnls.length
  if (n < 2) return 0
  const mean = pnls.reduce((a, b) => a + b, 0) / n
  let varSum = 0
  for (const p of pnls) varSum += (p - mean) ** 2
  const std = Math.sqrt(varSum / (n - 1))
  if (std < 1e-12) return mean > 0 ? 999 : 0
  return Math.sqrt(n) * (mean / std)
}

function isLongSide(side: string): boolean {
  return String(side).toLowerCase().includes('long')
}

function isShortSide(side: string): boolean {
  return String(side).toLowerCase().includes('short')
}

function computeSideBucket(trades: TradeRow[], volume: number, notionalFallback: number): SideBucketStats {
  if (!trades.length) return emptySideStats()
  const pnls = trades.map((t) => Number(t.pnl) || 0)
  const wins = pnls.filter((p) => p > 0)
  const losses = pnls.filter((p) => p < 0)
  const net = pnls.reduce((a, b) => a + b, 0)
  const grossWin = wins.reduce((a, b) => a + b, 0)
  const grossLossAbs = Math.abs(losses.reduce((a, b) => a + b, 0))
  const durs = trades.map((t) => Math.max(0, toUnix(t.exit_time) - toUnix(t.entry_time)) / 3600)
  const winDurs: number[] = []
  const lossDurs: number[] = []
  trades.forEach((_, i) => {
    const p = pnls[i]
    if (p > 0) winDurs.push(durs[i])
    else if (p < 0) lossDurs.push(durs[i])
  })
  let notionalSum = 0
  for (const t of trades) {
    const px = Number(t.entry_price || 0)
    notionalSum += px > 0 ? volume * px : notionalFallback
  }
  const avgNotional = notionalSum / trades.length
  const avgPnl = net / trades.length
  const mfes = trades.map((t) => Number(t.mfe ?? 0))
  const maes = trades.map((t) => Number(t.mae ?? 0))
  const avgMfe = mfes.reduce((a, b) => a + b, 0) / trades.length
  const avgMae = maes.reduce((a, b) => a + b, 0) / trades.length
  const { maxW, maxL } = streaks(pnls)
  return {
    trades: trades.length,
    netPnl: net,
    winRate: (100 * wins.length) / trades.length,
    expectancy: avgPnl,
    profitFactor: grossLossAbs > 1e-12 ? grossWin / grossLossAbs : grossWin > 0 ? 999 : 0,
    avgPnl,
    avgPnlPct: avgNotional > 1e-9 ? (avgPnl / avgNotional) * 100 : 0,
    avgDurationHours: durs.reduce((a, b) => a + b, 0) / durs.length,
    avgWinDurationHours: winDurs.length ? winDurs.reduce((a, b) => a + b, 0) / winDurs.length : 0,
    avgLossDurationHours: lossDurs.length ? lossDurs.reduce((a, b) => a + b, 0) / lossDurs.length : 0,
    largestWin: wins.length ? Math.max(...wins) : 0,
    largestLoss: losses.length ? Math.min(...losses) : 0,
    winCount: wins.length,
    lossCount: losses.length,
    avgMfe,
    avgMae,
    eRatio: avgMae > 1e-12 ? avgMfe / avgMae : avgMfe > 0 ? 999 : 0,
    sqn: sqnFromPnls(pnls),
    maxConsecWins: maxW,
    maxConsecLosses: maxL,
  }
}

function toUnix(iso: string): number {
  const t = Math.floor(new Date(iso).getTime() / 1000)
  return Number.isFinite(t) ? t : 0
}

function dedupeTimeSeries(points: { time: number; value: number }[]): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = []
  for (const p of points) {
    if (!Number.isFinite(p.time) || !Number.isFinite(p.value)) continue
    const last = out[out.length - 1]
    if (last && p.time < last.time) continue
    if (last && p.time === last.time) {
      last.value = p.value
      continue
    }
    out.push({ time: p.time, value: p.value })
  }
  return out
}

function streaks(pnls: number[]): { maxW: number; maxL: number } {
  let maxW = 0
  let maxL = 0
  let curW = 0
  let curL = 0
  for (const p of pnls) {
    if (p > 0) {
      curW += 1
      curL = 0
      maxW = Math.max(maxW, curW)
    } else if (p < 0) {
      curL += 1
      curW = 0
      maxL = Math.max(maxL, curL)
    } else {
      curW = curL = 0
    }
  }
  return { maxW, maxL }
}

function downsample(values: number[], n = 24): number[] {
  if (!values.length) return []
  if (values.length <= n) return values.map((v) => v)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const idx = Math.floor((i * (values.length - 1)) / (n - 1))
    out.push(values[idx])
  }
  return out
}

function normalizeSpark(values: number[]): number[] {
  if (!values.length) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return values.map((v) => (v - min) / span)
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return Number.NaN
  return Math.max(-9999.99, Math.min(9999.99, n))
}

function nearestEquityAt(equity: EquityPoint[], t: number): number {
  if (!equity.length) return 0
  let best = equity[0]
  let bestD = Math.abs(equity[0].time - t)
  for (const e of equity) {
    const d = Math.abs(e.time - t)
    if (d < bestD) {
      best = e
      bestD = d
    }
    if (e.time > t && d > bestD) break
  }
  return best.equity
}

/** Post-process existing backtest result into dashboard series + metrics (no re-run). */
export function computeDashboard(data: BacktestResult): DashboardModel {
  const volume = Number(data.volume || 0.01)
  const stats = data.stats || ({} as BacktestResult['stats'])
  const trades = data.trades || []

  const rawEq = dedupeTimeSeries(
    (data.equity || []).map((e) => ({ time: toUnix(e.time), value: Number(e.equity) })),
  )
  if (rawEq.length === 1) {
    rawEq.unshift({ time: rawEq[0].time - 60, value: 0 })
  }
  if (!rawEq.length) {
    rawEq.push({ time: Math.floor(Date.now() / 1000), value: 0 })
  }

  // Underwater + cumulative return
  // Equity is typically cumulative PnL from ~0 — defer return base until notional is known
  const equity: EquityPoint[] = []
  let peak = rawEq[0].value
  const startEq = rawEq[0].value
  for (const p of rawEq) {
    peak = Math.max(peak, p.value)
    const ddAbs = peak - p.value
    const ddPct = peak !== 0 ? (ddAbs / Math.max(Math.abs(peak), 1e-9)) * 100 : 0
    equity.push({
      time: p.time,
      equity: p.value,
      drawdownPct: -Math.abs(clampPct(ddPct) || 0),
      cumReturnPct: 0,
      peak,
    })
  }

  // Buy & hold from bars (same volume, long from first close)
  const bars = data.bars || []
  let buyHold: { time: number; value: number }[] = []
  if (bars.length >= 2) {
    const firstClose = Number(bars[0].close)
    const t0 = Number(bars[0].time)
    if (firstClose > 0 && Number.isFinite(t0)) {
      buyHold = bars.map((b) => ({
        time: Number(b.time),
        value: volume * (Number(b.close) - firstClose),
      }))
      buyHold = dedupeTimeSeries(buyHold)
    }
  }

  const markers: MarkerPoint[] = []
  for (const t of trades) {
    const pnl = Number(t.pnl)
    const win = pnl > 0
    const et = toUnix(t.entry_time)
    const xt = toUnix(t.exit_time)
    if (et) {
      markers.push({
        time: et,
        equity: nearestEquityAt(equity, et),
        pnl,
        win,
        side: t.side,
        kind: 'entry',
      })
    }
    if (xt) {
      markers.push({
        time: xt,
        equity: nearestEquityAt(equity, xt),
        pnl,
        win,
        side: t.side,
        kind: 'exit',
      })
    }
  }

  // Max DD duration (peak → trough → recovery), hours
  let maxDdDurationHours = 0
  {
    let runPeak = equity[0]?.equity ?? 0
    let peakTime = equity[0]?.time ?? 0
    let inDd = false
    let ddStart = peakTime
    for (const e of equity) {
      if (e.equity >= runPeak - 1e-12) {
        if (inDd) {
          maxDdDurationHours = Math.max(maxDdDurationHours, (e.time - ddStart) / 3600)
          inDd = false
        }
        runPeak = e.equity
        peakTime = e.time
      } else if (!inDd) {
        inDd = true
        ddStart = peakTime
      }
    }
    if (inDd && equity.length) {
      maxDdDurationHours = Math.max(
        maxDdDurationHours,
        (equity[equity.length - 1].time - ddStart) / 3600,
      )
    }
  }

  const pnls = trades.map((t) => Number(t.pnl))
  const wins = pnls.filter((p) => p > 0)
  const losses = pnls.filter((p) => p < 0)
  const { maxW, maxL } = streaks(pnls)

  const net = Number(stats.net_pnl ?? pnls.reduce((s, p) => s + p, 0))
  const endEq = equity[equity.length - 1]?.equity ?? net
  const tSpanSec = Math.max(1, (equity[equity.length - 1]?.time ?? 0) - (equity[0]?.time ?? 0))
  const spanDays = tSpanSec / 86400
  const years = tSpanSec / (365.25 * 24 * 3600)

  // Cumulative-PnL curves start near 0 — use position notional as % base
  const notional =
    bars.length && Number(bars[0].close) > 0
      ? Math.max(volume * Number(bars[0].close), 1e-6)
      : Math.max(Math.abs(endEq), Math.abs(net), 1)
  const returnBase = Math.abs(startEq) > 1e-6 ? Math.abs(startEq) : notional
  const totalReturnPct = clampPct(((endEq - startEq) / returnBase) * 100)
  for (const e of equity) {
    e.cumReturnPct = clampPct(((e.equity - startEq) / returnBase) * 100)
  }

  // CAGR unstable on very short windows — NaN → UI shows N/A
  let cagrPct = Number.NaN
  if (spanDays >= 7 && years > 0) {
    const endFactor = 1 + (endEq - startEq) / returnBase
    if (endFactor > 0 && Number.isFinite(endFactor)) {
      cagrPct = clampPct((Math.pow(endFactor, 1 / years) - 1) * 100)
    }
  }

  // Equity step returns for vol
  const rets: number[] = []
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].equity
    const base = Math.max(Math.abs(prev), 1e-9)
    rets.push((equity[i].equity - prev) / base)
  }
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0
  const variance =
    rets.length > 1
      ? rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (rets.length - 1)
      : 0
  const stepStd = Math.sqrt(Math.max(0, variance))
  const stepsPerYear = years > 0 ? rets.length / years : 0
  const maxDdAbs = Number(stats.max_drawdown ?? Math.max(...equity.map((e) => e.peak - e.equity), 0))
  const maxPeak = Math.max(...equity.map((e) => Math.abs(e.peak)), 1e-9)
  const maxDrawdownPct = clampPct((maxDdAbs / maxPeak) * 100) || 0
  const volatilityAnnPct = clampPct(stepStd * Math.sqrt(Math.max(stepsPerYear, 1)) * 100) || 0

  let avgTradeDurationHours = 0
  let avgWinDurationHours = 0
  let avgLossDurationHours = 0
  const winDurs: number[] = []
  const lossDurs: number[] = []
  if (trades.length) {
    const durs = trades.map((t) => {
      const h = Math.max(0, toUnix(t.exit_time) - toUnix(t.entry_time)) / 3600
      if (Number(t.pnl) > 0) winDurs.push(h)
      else if (Number(t.pnl) < 0) lossDurs.push(h)
      return h
    })
    avgTradeDurationHours = durs.reduce((a, b) => a + b, 0) / durs.length
    avgWinDurationHours = winDurs.length
      ? winDurs.reduce((a, b) => a + b, 0) / winDurs.length
      : 0
    avgLossDurationHours = lossDurs.length
      ? lossDurs.reduce((a, b) => a + b, 0) / lossDurs.length
      : 0
  }

  // Exposure from trade intervals vs span
  let inMarketSec = 0
  const intervals = trades
    .map((t) => ({ a: toUnix(t.entry_time), b: toUnix(t.exit_time) }))
    .filter((x) => x.b > x.a)
    .sort((x, y) => x.a - y.a)
  let curA = 0
  let curB = 0
  for (const iv of intervals) {
    if (!curB) {
      curA = iv.a
      curB = iv.b
      continue
    }
    if (iv.a <= curB) curB = Math.max(curB, iv.b)
    else {
      inMarketSec += curB - curA
      curA = iv.a
      curB = iv.b
    }
  }
  if (curB) inMarketSec += curB - curA
  const timeInMarketPct = (inMarketSec / tSpanSec) * 100

  const avgPositionSize = volume
  const turnover = trades.length * 2 // entry+exit legs proxy

  const bhEnd = buyHold.length ? buyHold[buyHold.length - 1].value : 0
  const bhNotional = notional
  const bhTotalReturnPct = clampPct(bhNotional > 1e-9 ? (bhEnd / bhNotional) * 100 : 0)
  const excessReturnPct = clampPct(totalReturnPct - bhTotalReturnPct)

  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
  const avgWinLossRatio = Math.abs(avgLoss) > 1e-12 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? 999 : 0

  // Average drawdown % across underwater periods
  const ddSamples = equity.map((e) => Math.abs(e.drawdownPct)).filter((d) => d > 1e-9)
  const avgDrawdownPct = ddSamples.length
    ? ddSamples.reduce((a, b) => a + b, 0) / ddSamples.length
    : 0
  const recoveryFactor = maxDdAbs > 1e-12 ? net / maxDdAbs : net > 0 ? 999 : 0
  const maxDdDurationDays = maxDdDurationHours / 24
  const barSec = Math.max(60, Number(data.tf_minutes || 15) * 60)
  const maxDdDurationBars = Math.round((maxDdDurationHours * 3600) / barSec)

  const longTrades = trades.filter((t) => String(t.side).toLowerCase().includes('long')).length
  const shortTrades = trades.filter((t) => String(t.side).toLowerCase().includes('short')).length
  const avgTradePnl = pnls.length ? net / pnls.length : 0
  const avgNotional = notional
  const avgTradePnlPct = clampPct((avgTradePnl / avgNotional) * 100) || 0
  const avgDrawdownPctClamped = clampPct(avgDrawdownPct) || 0

  // Monthly returns from equity month-end deltas (IST-ish via UTC date of equity stamps)
  const monthlyMap = new Map<string, { start: number; end: number; trades: number }>()
  for (const e of equity) {
    const d = new Date(e.time * 1000)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
    const cur = monthlyMap.get(key)
    if (!cur) monthlyMap.set(key, { start: e.equity, end: e.equity, trades: 0 })
    else cur.end = e.equity
  }
  for (const t of trades) {
    const d = new Date(toUnix(t.exit_time) * 1000)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
    const cur = monthlyMap.get(key)
    if (cur) cur.trades += 1
    else monthlyMap.set(key, { start: 0, end: 0, trades: 1 })
  }
  const monthlyReturns: MonthlyCell[] = [...monthlyMap.entries()]
    .map(([key, v]) => {
      const [ys, ms] = key.split('-').map(Number)
      return {
        year: ys,
        month: ms,
        returnPct:
          clampPct(
            ((v.end - v.start) / Math.max(Math.abs(v.start), returnBase * 0.01, 1e-6)) * 100,
          ) || 0,
        trades: v.trades,
      }
    })
    .sort((a, b) => a.year - b.year || a.month - b.month)

  const recentTrades: RecentTradeRow[] = trades.slice(-5).reverse().map((t, i) => {
    const durH = Math.max(0, toUnix(t.exit_time) - toUnix(t.entry_time)) / 3600
    const entryPx = Number(t.entry_price || 0)
    const notional = entryPx > 0 ? volume * entryPx : avgNotional
    const pnl = Number(t.pnl)
    return {
      idx: trades.length - i,
      date: t.exit_time,
      symbol: String(data.symbol || '—'),
      type: String(t.side || '—'),
      pnl,
      pnlPct: notional > 1e-9 ? (pnl / notional) * 100 : 0,
      durationHours: durH,
    }
  })

  const allTradeRows: RecentTradeRow[] = trades.map((t, i) => {
    const durH = Math.max(0, toUnix(t.exit_time) - toUnix(t.entry_time)) / 3600
    const entryPx = Number(t.entry_price || 0)
    const notionalT = entryPx > 0 ? volume * entryPx : avgNotional
    const pnl = Number(t.pnl)
    return {
      idx: i + 1,
      date: t.exit_time,
      symbol: String(data.symbol || '—'),
      type: String(t.side || '—'),
      pnl,
      pnlPct: notionalT > 1e-9 ? (pnl / notionalT) * 100 : 0,
      durationHours: durH,
    }
  })

  const longList = trades.filter((t) => isLongSide(t.side))
  const shortList = trades.filter((t) => isShortSide(t.side))
  const bySide = {
    all: computeSideBucket(trades, volume, avgNotional),
    long: computeSideBucket(longList, volume, avgNotional),
    short: computeSideBucket(shortList, volume, avgNotional),
  }

  const equityRawSpark = downsample(equity.map((e) => e.equity))
  const ddRawSpark = downsample(equity.map((e) => e.drawdownPct))

  const metrics: DashboardMetrics = {
    totalReturnPct,
    cagrPct,
    cumulativePnl: net,
    sharpe: Number(stats.sharpe ?? 0),
    sortino: Number(stats.sortino ?? 0),
    calmar: Number(stats.calmar ?? 0),
    maxDrawdownPct,
    maxDrawdownAbs: maxDdAbs,
    maxDdDurationHours,
    maxDdDurationDays,
    maxDdDurationBars,
    avgDrawdownPct: avgDrawdownPctClamped,
    recoveryFactor,
    volatilityAnnPct,
    winRate: Number(stats.win_rate ?? (pnls.length ? (100 * wins.length) / pnls.length : 0)),
    profitFactor: Number(stats.profit_factor ?? 0),
    expectancy: Number(stats.expectancy ?? (pnls.length ? net / pnls.length : 0)),
    avgWin,
    avgLoss,
    avgWinLossRatio,
    totalTrades: Number(stats.trades ?? pnls.length),
    longTrades,
    shortTrades,
    avgTradeDurationHours,
    avgWinDurationHours,
    avgLossDurationHours,
    avgTradePnl,
    avgTradePnlPct,
    largestWin: wins.length ? Math.max(...wins) : 0,
    largestLoss: losses.length ? Math.min(...losses) : 0,
    maxConsecWins: Number(stats.max_consec_wins ?? maxW),
    maxConsecLosses: Number(stats.max_consec_losses ?? maxL),
    avgMfe: Number(stats.avg_mfe ?? 0),
    avgMae: Number(stats.avg_mae ?? 0),
    eRatio: Number(stats.e_ratio ?? 0),
    sqn: Number(stats.sqn ?? 0),
    timeInMarketPct,
    avgPositionSize,
    turnover,
    bhTotalReturnPct,
    excessReturnPct,
    equitySpark: normalizeSpark(equityRawSpark),
    ddSpark: normalizeSpark(ddRawSpark),
    pnlSpark: normalizeSpark(downsample(pnls.length ? pnls : [0])),
    equityRawSpark,
    ddRawSpark,
  }

  return {
    equity,
    buyHold,
    markers,
    metrics,
    startEquity: startEq,
    monthlyReturns,
    recentTrades,
    allTradeRows,
    bySide,
    stepReturns: rets,
    stepsPerYear,
    symbol: String(data.symbol || ''),
  }
}

/** Sharpe adjusted for annual risk-free rate using step equity returns. */
export function sharpeWithRiskFree(
  stepReturns: number[],
  stepsPerYear: number,
  rfAnnualPct: number,
): number {
  if (stepReturns.length < 2) return 0
  const mean = stepReturns.reduce((a, b) => a + b, 0) / stepReturns.length
  const variance =
    stepReturns.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (stepReturns.length - 1)
  const std = Math.sqrt(Math.max(0, variance))
  if (std < 1e-12) return 0
  const rfStep = stepsPerYear > 0 ? rfAnnualPct / 100 / stepsPerYear : 0
  return ((mean - rfStep) / std) * Math.sqrt(Math.max(stepsPerYear, 1))
}

export function rangeBounds(
  equity: EquityPoint[],
  range: '1M' | '3M' | '6M' | 'YTD' | 'All',
): { from: number; to: number } | null {
  if (!equity.length) return null
  const to = equity[equity.length - 1].time
  if (range === 'All') return { from: equity[0].time, to }
  const now = new Date(to * 1000)
  let fromDate: Date
  if (range === 'YTD') {
    fromDate = new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
  } else {
    const months = range === '1M' ? 1 : range === '3M' ? 3 : 6
    fromDate = new Date(to * 1000)
    fromDate.setUTCMonth(fromDate.getUTCMonth() - months)
  }
  const from = Math.floor(fromDate.getTime() / 1000)
  return { from: Math.max(from, equity[0].time), to }
}

export type TradeLite = Pick<TradeRow, 'entry_time' | 'exit_time' | 'pnl' | 'side'>
