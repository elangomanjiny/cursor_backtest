import { useMemo, useState } from 'react'
import type { BacktestResult } from '../api'
import { computeDashboard, INITIAL_CAPITAL } from '../dashboard/computeDashboard'
import { SyncedDepthCharts } from '../dashboard/SyncedDepthCharts'
import { ExcursionScatter } from '../dashboard/ExcursionScatter'
import { fmt2 } from '../format'

type Props = {
  data: BacktestResult | null
  /** Keep mounted when hidden so the chart can size correctly. */
  visible?: boolean
}

type SideFilter = 'both' | 'long' | 'short'
type ChartKind = 'equity' | 'excursion'

function rebuildBySide(data: BacktestResult, side: SideFilter): BacktestResult {
  if (side === 'both') return data
  const trades = data.trades.filter((t) => {
    const s = String(t.side).toLowerCase()
    return side === 'long' ? s.includes('long') : s.includes('short')
  })
  let run = 0
  const equity: { time: string; equity: number }[] = []
  if (trades.length > 0) {
    const t0 = trades[0].entry_time || trades[0].exit_time
    equity.push({ time: t0, equity: 0 })
    for (const t of trades) {
      run += Number(t.pnl) || 0
      equity.push({ time: t.exit_time, equity: run })
    }
  } else {
    equity.push({ time: data.equity[0]?.time || new Date().toISOString(), equity: 0 })
  }
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
  const [chartKind, setChartKind] = useState<ChartKind>('equity')
  const [capital, setCapital] = useState(INITIAL_CAPITAL)

  const scoped = useMemo(
    () => (data ? rebuildBySide(data, sideFilter) : null),
    [data, sideFilter],
  )
  const model = useMemo(
    () => (scoped ? computeDashboard(scoped, capital) : null),
    [scoped, capital],
  )

  if (!data || !scoped || !model) {
    if (!visible) return null
    return <p className="hint">No equity curve yet — run a backtest first.</p>
  }

  const net = Number(scoped.stats?.net_pnl ?? model.metrics.cumulativePnl)
  const mode =
    Number(data.pro_mtf_mode) || String(data.stats?.strategy_mode || '') === 'pro_mtf'
      ? 'Pro-MTF'
      : data.wait_and_trade
        ? 'Non-Directional'
        : data.pro_mode
          ? 'Pro'
          : 'Directional'

  return (
    <div
      className="panel equity-curve-panel"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      <header className="equity-curve-header equity-curve-header-one">
        <h2>
          Equity Curve · {data.symbol} {data.tf_minutes}m {mode} Net{' '}
          <b className={net >= 0 ? 'pos' : 'neg'}>{fmt2(net)}</b>
          {sideFilter !== 'both' && (
            <span className="equity-side-note"> · {sideFilter.toUpperCase()}</span>
          )}
        </h2>
        <label className="equity-cap-field" title="Starting capital for the equity series">
          Equity
          <input
            className="num-plain"
            type="number"
            min={1}
            step={1000}
            value={capital}
            onChange={(e) => {
              const n = Number(e.target.value)
              setCapital(Number.isFinite(n) && n > 0 ? n : INITIAL_CAPITAL)
            }}
          />
        </label>
        <select
          className="equity-kind-select"
          value={chartKind}
          onChange={(e) => setChartKind(e.target.value === 'excursion' ? 'excursion' : 'equity')}
          aria-label="Chart type"
        >
          <option value="equity">Equity</option>
          <option value="excursion">Excursion</option>
        </select>
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
      </header>
      <div className="equity-curve-body">
        {chartKind === 'equity' ? (
          <SyncedDepthCharts model={model} visible={visible} startCapital={capital} />
        ) : (
          <ExcursionScatter trades={scoped.trades} symbol={data.symbol} />
        )}
      </div>
    </div>
  )
}
