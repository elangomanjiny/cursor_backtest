import { useCallback, useMemo, useState } from 'react'
import type { AggressiveRow, BacktestResult, BarRow, TradeRow } from '../api'
import { fmtMinsBars, tradeExcursionTiming, type ExcursionSeq } from '../dashboard/excursionTiming'
import { fmt2, fmtCost } from '../format'
import { selectTrade, useChartStudy } from '../chartStudyStore'
import { SortTh, useSortable } from '../useSortable'

function findSignalBar(data: BacktestResult, t: TradeRow): BarRow | AggressiveRow | null {
  const sig = t.signal_time
  const byTime = data.aggressive.find((a) => a.time.slice(0, 19) === sig.slice(0, 19))
  if (byTime) return byTime
  const agg = data.aggressive.find(
    (a) =>
      Math.abs(a.high - t.signal_high) < 1e-6 &&
      Math.abs(a.low - t.signal_low) < 1e-6,
  )
  if (agg) return agg
  const bar = data.bars.find((b) => b.time_iso.slice(0, 19) === sig.slice(0, 19))
  return bar || null
}

function splitDT(iso: string) {
  const s = iso.replace('T', ' ')
  return { date: s.slice(0, 10), time: s.slice(11, 19) }
}

/** Clock HH:MM:SS — drops milliseconds for table display. */
function clockTime(iso: string): string {
  const t = iso.replace('T', ' ').slice(11)
  return t.slice(0, 8)
}

/** Signed price points favoring the trade side (Long: exit−entry, Short: entry−exit). */
function tradePoints(t: TradeRow): number {
  const entry = Number(t.entry_price)
  const exit = Number(t.exit_price)
  return t.side === 'Short' ? entry - exit : exit - entry
}

/** Binance UM instrument tick size (price increment) — not an average. */
function instrumentTickSize(symbol: string): number {
  const s = symbol.toUpperCase()
  if (s.startsWith('BTC')) return 0.1
  if (s.startsWith('ETH')) return 0.01
  if (s.startsWith('BNB')) return 0.01
  if (s.startsWith('SOL')) return 0.01
  return 0.01
}

type TradeView = {
  idx: number
  date: string
  sigTime: string
  side: string
  o: number
  h: number
  l: number
  c: number
  v: number
  dlt: number
  dp: number
  rng: number
  entryTime: string
  entryTimeSort: string
  entryPrice: number
  exitTime: string
  exitTimeSort: string
  exitPrice: number
  points: number
  lots: number
  entryTag: string
  exitTag: string
  slip: number
  fee: number
  slipTip: string
  feeTip: string
  totalCost: number
  grossPnl: number
  pnl: number
  cumPnl: number
  mfeTicks: number
  maeTicks: number
  mfePts: number
  maePts: number
  mfeLabel: string
  maeLabel: string
  eRatio: number
  tMfeMin: number
  tMaeMin: number
  dtMin: number
  tMfeLabel: string
  tMaeLabel: string
  dtLabel: string
  seq: ExcursionSeq
  tMfePct: number
}

type AggrView = {
  idx: number
  time: string
  timeSort: string
  side: string
  o: number
  h: number
  l: number
  c: number
  dp: number
  rng: number
}

type Props = {
  data: BacktestResult | null
  /** Jump to Visualization after selecting a trade */
  onOpenOnChart?: () => void
}

export function TradesTab({ data, onOpenOnChart }: Props) {
  const study = useChartStudy()
  /** Default: trades maximized, aggressive minimized */
  const [tradesMax, setTradesMax] = useState(true)
  const [aggrMax, setAggrMax] = useState(false)

  const tradeRows = useMemo(() => {
    if (!data) return [] as TradeView[]
    const tick = instrumentTickSize(data.symbol)
    const slipPct = Number(data.params?.slippage_pct ?? data.stats?.slippage_pct ?? 0)
    const feePct = Number(data.params?.fee_pct ?? data.stats?.fee_pct ?? 0)
    let run = 0
    return data.trades.map((t, i) => {
      run += Number(t.pnl) || 0
      const lots = Number(t.lots ?? data.volume)
      const sig = findSignalBar(data, t)
      const sigDT = splitDT(t.signal_time)
      const o =
        sig && 'open' in sig && sig.open != null ? Number(sig.open) : t.signal_high
      const h = sig ? Number(sig.high) : t.signal_high
      const l = sig ? Number(sig.low) : t.signal_low
      const c =
        sig && 'close' in sig && sig.close != null ? Number(sig.close) : t.signal_low
      const v =
        sig && 'volume_usdt' in sig && sig.volume_usdt != null
          ? Number(sig.volume_usdt)
          : sig && 'volume' in sig
            ? Number((sig as BarRow).volume)
            : 0
      const dlt =
        sig && 'delta_usdt' in sig && sig.delta_usdt != null
          ? Number(sig.delta_usdt)
          : sig && 'delta' in sig
            ? Number((sig as BarRow).delta)
            : 0
      const dp = sig ? Number(sig.delta_pct) : t.signal_delta_pct
      const rng =
        sig && 'range' in sig && sig.range != null
          ? Number(sig.range)
          : t.range ?? t.signal_high - t.signal_low
      const mfe = Math.abs(Number(t.mfe ?? 0))
      const maeAbs = Math.abs(Number(t.mae ?? 0))
      const mae = -maeAbs
      const mfeTicks = tick > 0 ? mfe / tick : 0
      const maeTicks = tick > 0 ? mae / tick : 0
      const eRatio = maeAbs > 1e-12 ? mfe / maeAbs : mfe > 0 ? 999 : 0
      const timing = tradeExcursionTiming(t, data.tf_minutes)
      const slip = Number(t.slippage ?? 0)
      const fee = Number(t.fee ?? 0)
      const feeExpect =
        (Math.abs(Number(t.entry_price)) + Math.abs(Number(t.exit_price))) *
        lots *
        (feePct / 100)
      const avg = (Math.abs(Number(t.entry_price)) + Math.abs(Number(t.exit_price))) / 2
      const slipTip = `Both fills: long entry + / exit −, short entry − / exit +. Slip% ${slipPct}. Quote ${fmtCost(slip)}.`
      const nAdds = Number(t.scale_n || 0)
      const feeTip =
        nAdds > 0
          ? `Scale-in: ${nAdds} add(s). Entry fee on each fill + exit on ${lots} lots. Engine ${fmtCost(fee)}.`
          : `After slip, both legs: (entry+exit)×lots×Fee%/100 = 2×avg(${fmt2(avg)})×${lots}×${feePct}/100 = ${fmtCost(feeExpect)}`
      return {
        idx: i,
        date: sigDT.date,
        sigTime: sigDT.time.slice(0, 5),
        side: t.side,
        o,
        h,
        l,
        c,
        v,
        dlt,
        dp,
        rng,
        entryTime: clockTime(t.entry_time),
        entryTimeSort: t.entry_time,
        entryPrice: t.entry_price,
        exitTime: clockTime(t.exit_time),
        exitTimeSort: t.exit_time,
        exitPrice: t.exit_price,
        points: tradePoints(t),
        lots,
        entryTag: t.entry_tag || (t.side === 'Short' ? 'SE' : 'LE'),
        exitTag: t.exit_reason,
        slip,
        fee,
        slipTip,
        feeTip,
        totalCost: slip + fee,
        grossPnl: (Number(t.pnl) || 0) + fee,
        pnl: t.pnl,
        cumPnl: run,
        mfeTicks,
        maeTicks,
        mfePts: mfe,
        maePts: mae,
        mfeLabel: `${fmt2(mfeTicks)} / ${fmt2(mfe)}`,
        maeLabel: `${fmt2(maeTicks)} / ${fmt2(mae)}`,
        eRatio,
        tMfeMin: timing.tMfeMin ?? -1,
        tMaeMin: timing.tMaeMin ?? -1,
        dtMin: timing.dtMin ?? 0,
        tMfeLabel: fmtMinsBars(timing.tMfeMin, timing.tMfeBars),
        tMaeLabel: fmtMinsBars(timing.tMaeMin, timing.tMaeBars),
        dtLabel:
          timing.dtMin == null
            ? '—'
            : `${timing.dtMin >= 0 ? '+' : ''}${fmt2(timing.dtMin)}`,
        seq: timing.seq,
        tMfePct: timing.tMfePct ?? -1,
      }
    })
  }, [data])

  const aggrRows = useMemo(() => {
    if (!data) return [] as AggrView[]
    return data.aggressive.map((a, i) => ({
      idx: i,
      time: a.time.slice(0, 16).replace('T', ' '),
      timeSort: a.time,
      side: a.side,
      o: Number(a.open ?? 0),
      h: a.high,
      l: a.low,
      c: Number(a.close ?? 0),
      dp: a.delta_pct,
      rng: a.range,
    }))
  }, [data])

  const tradeGet = useCallback((row: TradeView, key: string): unknown => {
    return (row as unknown as Record<string, unknown>)[key]
  }, [])
  const aggrGet = useCallback((row: AggrView, key: string): unknown => {
    return (row as unknown as Record<string, unknown>)[key]
  }, [])

  const tradesSort = useSortable(tradeRows, tradeGet, { key: 'idx', dir: 'asc' })
  const aggrSort = useSortable(aggrRows, aggrGet, { key: 'idx', dir: 'asc' })

  if (!data) return <p className="hint">No trades yet.</p>

  const pick = (i: number) => {
    selectTrade(i)
    onOpenOnChart?.()
  }

  return (
    <div className="panel trades-panel">
      <div className="panel-head">
        <p className="hint">
          Click a trade row to jump to it on the Visualization chart. Click column headers to sort.
          MFE / MAE shown as <b>ticks / price</b> (tick={data ? instrumentTickSize(data.symbol) : '—'}
          ). MAE is signed negative (adverse). E-ratio = |MFE|÷|MAE| in price. tMFE / tMAE =
          minutes / bars to the first extreme. ΔT = tMFE − tMAE; MAE→ = drawdown first, MFE→ =
          green first.
        </p>
      </div>

      <div className="trades-split">
        <div className={`trades-pane ${tradesMax ? 'pane-max' : 'pane-min'}`}>
          <div className="pane-head">
            <span>Trades</span>
            <button
              type="button"
              className="ghost pane-toggle-btn"
              title={tradesMax ? 'Minimize trades table' : 'Maximize trades table'}
              onClick={() => setTradesMax((v) => !v)}
            >
              {tradesMax ? '▬' : '⛶'}
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <SortTh col="idx" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    #
                  </SortTh>
                  <SortTh col="date" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Date
                  </SortTh>
                  <SortTh col="sigTime" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Time
                  </SortTh>
                  <SortTh col="side" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Side
                  </SortTh>
                  <SortTh col="o" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    O
                  </SortTh>
                  <SortTh col="h" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    H
                  </SortTh>
                  <SortTh col="l" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    L
                  </SortTh>
                  <SortTh col="c" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    C
                  </SortTh>
                  <SortTh col="v" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    V
                  </SortTh>
                  <SortTh col="dlt" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Delta
                  </SortTh>
                  <SortTh col="dp" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Delta%
                  </SortTh>
                  <SortTh col="rng" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Range
                  </SortTh>
                  <SortTh col="entryTimeSort" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    EntryTime
                  </SortTh>
                  <SortTh col="entryPrice" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    EntryPrice
                  </SortTh>
                  <SortTh col="exitTimeSort" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    ExitTime
                  </SortTh>
                  <SortTh col="exitPrice" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    ExitPrice
                  </SortTh>
                  <SortTh col="points" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Points
                  </SortTh>
                  <SortTh col="lots" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Lots
                  </SortTh>
                  <SortTh col="entryTag" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Entry Tag
                  </SortTh>
                  <SortTh col="exitTag" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Exit Tag
                  </SortTh>
                  <SortTh
                    col="slip"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="Both fills: |entry slip| + |exit slip| × lots. Long +/−, short −/+."
                  >
                    Slip
                  </SortTh>
                  <SortTh
                    col="fee"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="After slip, both legs: (entry+exit)×lots×Fee%/100 = 2×avg×lots×Fee%/100."
                  >
                    Fee
                  </SortTh>
                  <SortTh
                    col="totalCost"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="Total Cost = Slip + Fee. Informational. Net = Gross − Fee only (slip is already in Entry/Exit)."
                  >
                    TotalCost
                  </SortTh>
                  <SortTh
                    col="grossPnl"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="Fill Gross = Points × Lots = Net + Fee. Slip is already in Entry/Exit; do not add it again."
                  >
                    Gross PnL
                  </SortTh>
                  <SortTh col="pnl" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    PnL
                  </SortTh>
                  <SortTh col="cumPnl" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    CumPnL
                  </SortTh>
                  <SortTh
                    col="mfePts"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="Maximum Favorable Excursion — ticks / price points"
                  >
                    MFE
                  </SortTh>
                  <SortTh
                    col="maePts"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="Maximum Adverse Excursion — ticks / price points"
                  >
                    MAE
                  </SortTh>
                  <SortTh
                    col="eRatio"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="Per-trade MFE÷MAE (ticks)"
                  >
                    E-ratio
                  </SortTh>
                  <SortTh
                    col="tMfeMin"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="Time to first MFE — minutes / bars"
                  >
                    tMFE
                  </SortTh>
                  <SortTh
                    col="tMaeMin"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="Time to first MAE — minutes / bars"
                  >
                    tMAE
                  </SortTh>
                  <SortTh
                    col="dtMin"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="ΔT = tMFE − tMAE. Positive = MAE first."
                  >
                    ΔT
                  </SortTh>
                  <SortTh
                    col="seq"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="MAE→ drawdown first. MFE→ green first."
                  >
                    Seq
                  </SortTh>
                  <SortTh
                    col="tMfePct"
                    sort={tradesSort.sort}
                    onSort={tradesSort.toggle}
                    title="tMFE as % of hold. High = momentum into the exit."
                  >
                    tMFE%
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {tradesSort.sorted.map((r) => {
                  const active = study.selectedTrade === r.idx
                  return (
                    <tr
                      key={r.idx}
                      className={active ? 'trade-row-active' : 'trade-row'}
                      onClick={() => pick(r.idx)}
                      title="Show on chart"
                    >
                      <td>{r.idx + 1}</td>
                      <td>{r.date}</td>
                      <td>{r.sigTime}</td>
                      <td>{r.side}</td>
                      <td>{fmt2(r.o)}</td>
                      <td>{fmt2(r.h)}</td>
                      <td>{fmt2(r.l)}</td>
                      <td>{fmt2(r.c)}</td>
                      <td>{fmt2(r.v)}</td>
                      <td className={r.dlt >= 0 ? 'pos' : 'neg'}>{fmt2(r.dlt)}</td>
                      <td className={r.dp >= 0 ? 'pos' : 'neg'}>{fmt2(r.dp)}</td>
                      <td>{fmt2(r.rng)}</td>
                      <td>{r.entryTime}</td>
                      <td>{fmt2(r.entryPrice)}</td>
                      <td>{r.exitTime}</td>
                      <td>{fmt2(r.exitPrice)}</td>
                      <td className={r.points >= 0 ? 'pos' : 'neg'}>{fmt2(r.points)}</td>
                      <td>{fmt2(r.lots)}</td>
                      <td>{r.entryTag}</td>
                      <td>{r.exitTag}</td>
                      <td className="neg" title={r.slipTip}>
                        {fmtCost(r.slip)}
                      </td>
                      <td className="neg" title={r.feeTip}>
                        {fmtCost(r.fee)}
                      </td>
                      <td className="neg" title={`Slip ${fmtCost(r.slip)} + Fee ${fmtCost(r.fee)}`}>
                        {fmtCost(r.totalCost)}
                      </td>
                      <td className={r.grossPnl >= 0 ? 'pos' : 'neg'}>{fmt2(r.grossPnl)}</td>
                      <td className={r.pnl >= 0 ? 'pos' : 'neg'}>{fmt2(r.pnl)}</td>
                      <td className={r.cumPnl >= 0 ? 'pos' : 'neg'}>{fmt2(r.cumPnl)}</td>
                      <td className="pos" title={`${fmt2(r.mfeTicks)} ticks`}>
                        {r.mfeLabel}
                      </td>
                      <td className="neg" title={`${fmt2(r.maeTicks)} ticks`}>
                        {r.maeLabel}
                      </td>
                      <td>{fmt2(r.eRatio)}</td>
                      <td title={r.tMfeLabel}>{r.tMfeLabel}</td>
                      <td title={r.tMaeLabel}>{r.tMaeLabel}</td>
                      <td
                        className={
                          r.dtLabel === '—' ? undefined : r.dtMin >= 0 ? 'pos' : 'neg'
                        }
                      >
                        {r.dtLabel}
                      </td>
                      <td
                        className={
                          r.seq === 'MAE→' ? 'neg' : r.seq === 'MFE→' ? 'pos' : undefined
                        }
                      >
                        {r.seq}
                      </td>
                      <td>{r.tMfePct < 0 ? '—' : `${fmt2(r.tMfePct)}%`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className={`trades-pane ${aggrMax ? 'pane-max' : 'pane-min'}`}>
          <div className="pane-head">
            <span>Aggressive candles</span>
            <button
              type="button"
              className="ghost pane-toggle-btn"
              title={aggrMax ? 'Minimize aggressive table' : 'Maximize aggressive table'}
              onClick={() => setAggrMax((v) => !v)}
            >
              {aggrMax ? '▬' : '⛶'}
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <SortTh col="idx" sort={aggrSort.sort} onSort={aggrSort.toggle}>
                    #
                  </SortTh>
                  <SortTh col="timeSort" sort={aggrSort.sort} onSort={aggrSort.toggle}>
                    Time
                  </SortTh>
                  <SortTh col="side" sort={aggrSort.sort} onSort={aggrSort.toggle}>
                    Side
                  </SortTh>
                  <SortTh col="o" sort={aggrSort.sort} onSort={aggrSort.toggle}>
                    O
                  </SortTh>
                  <SortTh col="h" sort={aggrSort.sort} onSort={aggrSort.toggle}>
                    H
                  </SortTh>
                  <SortTh col="l" sort={aggrSort.sort} onSort={aggrSort.toggle}>
                    L
                  </SortTh>
                  <SortTh col="c" sort={aggrSort.sort} onSort={aggrSort.toggle}>
                    C
                  </SortTh>
                  <SortTh col="dp" sort={aggrSort.sort} onSort={aggrSort.toggle}>
                    Δ%
                  </SortTh>
                  <SortTh col="rng" sort={aggrSort.sort} onSort={aggrSort.toggle}>
                    Range
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {aggrSort.sorted.map((a) => (
                  <tr key={a.idx}>
                    <td>{a.idx + 1}</td>
                    <td>{a.time}</td>
                    <td>{a.side}</td>
                    <td>{fmt2(a.o)}</td>
                    <td>{fmt2(a.h)}</td>
                    <td>{fmt2(a.l)}</td>
                    <td>{fmt2(a.c)}</td>
                    <td className={a.dp >= 0 ? 'pos' : 'neg'}>{fmt2(a.dp)}</td>
                    <td>{fmt2(a.rng)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
