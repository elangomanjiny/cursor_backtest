import { useMemo } from 'react'
import type { BacktestResult } from '../api'
import { computeDashboard } from '../dashboard/computeDashboard'
import { SyncedDepthCharts } from '../dashboard/SyncedDepthCharts'
import { fmt2 } from '../format'

type Props = {
  data: BacktestResult | null
  /** Keep mounted when hidden so the chart can size correctly. */
  visible?: boolean
}

export function EquityTab({ data, visible = true }: Props) {
  const model = useMemo(() => (data ? computeDashboard(data) : null), [data])

  if (!data || !model) {
    if (!visible) return null
    return <p className="hint">No equity curve yet — run a backtest first.</p>
  }

  const net = Number(data.stats?.net_pnl ?? model.metrics.cumulativePnl)
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
          </p>
        </div>
        <div className="equity-curve-legend">
          <span>
            <i style={{ background: '#22c55e' }} /> Cumulative PnL
          </span>
          <span>
            <i style={{ background: '#ef4444' }} /> Underwater DD
          </span>
        </div>
      </header>
      <div className="equity-curve-body">
        <SyncedDepthCharts model={model} visible={visible} />
      </div>
    </div>
  )
}
