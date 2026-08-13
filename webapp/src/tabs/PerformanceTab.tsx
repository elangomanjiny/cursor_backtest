import type { BacktestResult } from '../api'
import { PerformanceOverviewDashboard } from '../dashboard/PerformanceOverviewDashboard'

type Props = {
  data: BacktestResult | null
  visible?: boolean
}

export function PerformanceTab({ data, visible = true }: Props) {
  if (!data) {
    if (!visible) return null
    return <p className="hint">No performance stats yet — run a backtest first.</p>
  }

  return (
    <div
      className="panel performance-panel pod-shell"
      style={{ display: visible ? 'flex' : 'none', flexDirection: 'column' }}
    >
      <PerformanceOverviewDashboard data={data} visible={visible} />
    </div>
  )
}