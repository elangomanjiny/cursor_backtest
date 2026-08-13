import type { BacktestResult } from '../api'
import { PerformanceOverviewDashboard } from '../dashboard/PerformanceOverviewDashboard'

type Props = {
  data: BacktestResult | null
  /** Keep mounted when hidden so the chart can size correctly. */
  visible?: boolean
}

export function EquityTab({ data, visible = true }: Props) {
  if (!data) {
    if (!visible) return null
    return <p className="hint">No equity curve yet — run a backtest first.</p>
  }

  return (
    <div
      className="panel equity-panel equity-panel-dash pod-shell"
      style={{ display: visible ? 'flex' : 'none', flexDirection: 'column' }}
    >
      <PerformanceOverviewDashboard data={data} visible={visible} />
    </div>
  )
}
