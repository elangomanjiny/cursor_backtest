import { useMemo, useState } from 'react'
import type { BacktestResult } from '../api'
import { computeDashboard } from '../dashboard/computeDashboard'
import { SyncedDepthCharts } from '../dashboard/SyncedDepthCharts'
import { fmt2 } from '../format'

type Props = {
  data: BacktestResult | null
  /** Keep mounted when hidden so the chart can size correctly. */
  visible?: boolean
}

type SideFilter = 'both' | 'long' | 'short'

function rebuildBySide(data: BacktestResult, side: SideFilter): BacktestResult {
  if (side === 'both') return data
  const trades = data.trades.filter((t) => {
    const s = String(t.side).toLowerCase()
    return side === 'long' ? s.includes('long') : s.includes('short')
  })
  let run = 0
  const equity =
    trades.length > 0
      ? trades.map((t) => {
          run += Number(t.pnl) || 0
          return { time: t.exit_time, equity: run }
        })
      : [{ time: data.equity[0]?.time || new Date().toISOString(), equity: 0 }]
  const wins = trades.filter((t) => Number(t.pnl) > 0).length
  return {
    ...data,
    trades,
    equity,
    stats: {
      ...data.stats,
      trades: trades.length,
      net_pnl: run,
      win_rate: trades.length ? (100 * wins) / trades.length : 0,
    },
  }
}

export function EquityTab({ data, visible = true }: Props) {
  const [sideFilter, setSideFilter] = useState<SideFilter>('both')

  const scoped = useMemo(
    () => (data ? rebuildBySide(data, sideFilter) : null),
    [data, sideFilter],
  )
  const model = useMemo(() => (scoped ? computeDashboard(scoped) : null), [scoped])

  if (!data || !scoped || !model) {
    if (!visible) return null
    return <p className="hint">No equity curve yet — run a backtest first.</p>
  }

  const net = Number(scoped.stats?.net_pnl ?? model.metrics.cumulativePnl)
  const mode = data.wait_and_trade
    ? 'Non-Directional'
    : data.pro_mode
      ? 'Pro'
      : 'Directional'

  return (
    <div
      className="panel equity-curve-panel"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      <header className="equity-curve-header">
        <div>
          <h2>Equity Curve</h2>
          <p>
            {data.symbol} · {data.tf_minutes}m · {mode} · Net{' '}
            <b className={net >= 0 ? 'pos' : 'neg'}>{fmt2(net)}</b>
            {sideFilter !== 'both' && (
              <span className="equity-side-note"> · {sideFilter.toUpperCase()} only</span>
            )}
          </p>
        </div>
        <div className="equity-curve-tools">
          <div className="equity-side-filters" role="group" aria-label="Equity side filter">
            {(
              [
                ['long', 'LONG'],
                ['short', 'SHORT'],
                ['both', 'BOTH'],
              ] as const
            ).map(([id, lab]) => (
              <button
                key={id}
                type="button"
                className={`equity-side-btn${sideFilter === id ? ' on' : ''}`}
                onClick={() => setSideFilter(id)}
              >
                {lab}
              </button>
            ))}
          </div>
          <div className="equity-curve-legend">
            <span>
              <i style={{ background: '#22c55e' }} /> Cumulative PnL
            </span>
            <span>
              <i style={{ background: '#ef4444' }} /> Underwater DD
            </span>
          </div>
        </div>
      </header>
      <div className="equity-curve-body">
        <SyncedDepthCharts model={model} visible={visible} />
      </div>
    </div>
  )
}
