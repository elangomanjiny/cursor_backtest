import { useCallback, useMemo, useState } from 'react'
import type { AggressiveRow, BacktestResult, BarRow, TradeRow } from '../api'
import { fmt2 } from '../format'
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

/** Clock HH:MM:SS(.mmm) — keeps ms when tick exit differs from bar-open entry. */
function clockTime(iso: string): string {
  const t = iso.replace('T', ' ').slice(11)
  if (t.length >= 12 && t[8] === '.') return t.slice(0, 12) // HH:MM:SS.mmm
  return t.slice(0, 8)
}

/** Signed price points favoring the trade side (Long: exit−entry, Short: entry−exit). */
function tradePoints(t: TradeRow): number {
  const entry = Number(t.entry_price)
  const exit = Number(t.exit_price)
  return t.side === 'Short' ? entry - exit : exit - entry
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
  pnl: number
  cumPnl: number
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
  const [panelMax, setPanelMax] = useState(false)

  const tradeRows = useMemo(() => {
    if (!data) return [] as TradeView[]
    const lots = Number(data.volume)
    let run = 0
    return data.trades.map((t, i) => {
      run += Number(t.pnl) || 0
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
        slip: Number(t.slippage ?? 0),
        fee: Number(t.fee ?? 0),
        pnl: t.pnl,
        cumPnl: run,
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
    <div className={`panel trades-panel${panelMax ? ' panel-maximized' : ''}`}>
      <div className="panel-head">
        <p className="hint">
          Click a trade row to jump to it on the Visualization chart. Click column headers to sort.
        </p>
        <button
          type="button"
          className="ghost panel-max-btn"
          title={panelMax ? 'Restore panel' : 'Maximize panel'}
          onClick={() => setPanelMax((v) => !v)}
        >
          {panelMax ? '❐' : '⛶'}
        </button>
      </div>

      <div className="stats-grid compact-stats">
        <div className="stat-card">
          <div className="k">Trades</div>
          <div className="v">{Number(data.stats.trades)}</div>
        </div>
        <div className="stat-card">
          <div className="k">Aggressive</div>
          <div className="v">{Number(data.stats.aggressive)}</div>
        </div>
        <div className="stat-card">
          <div className="k">Net PnL</div>
          <div className={`v ${Number(data.stats.net_pnl) >= 0 ? 'pos' : 'neg'}`}>
            {fmt2(Number(data.stats.net_pnl))}
          </div>
        </div>
        <div className="stat-card">
          <div className="k">Σ Slippage</div>
          <div className="v">{fmt2(Number(data.stats.total_slippage ?? 0))}</div>
        </div>
        <div className="stat-card">
          <div className="k">Σ Fees</div>
          <div className="v">{fmt2(Number(data.stats.total_fees ?? 0))}</div>
        </div>
      </div>

      <div className="trades-split">
        <div className="trades-pane">
          <div className="pane-head">Trades</div>
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
                  <SortTh col="slip" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Slip
                  </SortTh>
                  <SortTh col="fee" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    Fee
                  </SortTh>
                  <SortTh col="pnl" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    PnL
                  </SortTh>
                  <SortTh col="cumPnl" sort={tradesSort.sort} onSort={tradesSort.toggle}>
                    CumPnL
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
                      <td>{fmt2(r.slip)}</td>
                      <td>{fmt2(r.fee)}</td>
                      <td className={r.pnl >= 0 ? 'pos' : 'neg'}>{fmt2(r.pnl)}</td>
                      <td className={r.cumPnl >= 0 ? 'pos' : 'neg'}>{fmt2(r.cumPnl)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="trades-pane">
          <div className="pane-head">Aggressive candles</div>
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
