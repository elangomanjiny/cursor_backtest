import { fmt2, fmtCost } from '../format'
import type { BacktestStats } from '../api'

const CATEGORIES: { name: string; keys: { key: string; label: string; suffix?: string }[] }[] = [
  {
    name: 'Risk',
    keys: [
      { key: 'max_drawdown', label: 'Max DD' },
      { key: 'avg_mae', label: 'MAE' },
      { key: 'ulcer_index', label: 'Ulcer' },
      { key: 'downside_deviation', label: 'DownDev' },
      { key: 'max_consec_losses', label: 'Consec L' },
      { key: 'risk_of_ruin_proxy', label: 'RoR≈' },
    ],
  },
  {
    name: 'Trading',
    keys: [
      { key: 'trades', label: 'Trades' },
      { key: 'win_rate', label: 'Win', suffix: '%' },
      { key: 'expectancy', label: 'Expect' },
      { key: 'avg_mfe', label: 'MFE' },
      { key: 'e_ratio', label: 'E-ratio' },
      { key: 'max_consec_wins', label: 'Consec W' },
      { key: 'payoff_ratio', label: 'Payoff' },
    ],
  },
  {
    name: 'Money',
    keys: [
      { key: 'net_pnl', label: 'Net PnL' },
      { key: 'total_slippage', label: 'Slip' },
      { key: 'total_fees', label: 'Fees' },
      { key: 'profit_factor', label: 'PF' },
      { key: 'gross_profit', label: 'Gross+' },
      { key: 'gross_loss', label: 'Gross−' },
      { key: 'recovery_factor', label: 'Recovery' },
      { key: 'kelly_fraction', label: 'Kelly', suffix: '%' },
    ],
  },
  {
    name: 'Strategy',
    keys: [
      { key: 'sqn', label: 'SQN' },
      { key: 'sharpe', label: 'Sharpe' },
      { key: 'sortino', label: 'Sortino' },
      { key: 'calmar', label: 'Calmar' },
      { key: 'avg_win', label: 'AvgW' },
      { key: 'avg_loss', label: 'AvgL' },
    ],
  },
]

type Props = {
  stats: BacktestStats | null
}

export function MetricsPanel({ stats }: Props) {
  if (!stats) {
    return (
      <div className="metrics-bar idle">
        <span className="strip-lab">METRICS</span>
        <span className="hint" style={{ margin: 0 }}>
          Run a backtest to populate categorized metrics
        </span>
      </div>
    )
  }

  return (
    <div className="metrics-bar">
      {CATEGORIES.map((cat) => (
        <div className="metric-cat" key={cat.name}>
          <span className="cat-name">{cat.name}</span>
          <div className="cat-items">
            {cat.keys.map(({ key, label, suffix }) => {
              const v = Number(stats[key] ?? 0)
              const cost = key === 'total_slippage' || key === 'total_fees'
              return (
                <span className="m-item" key={key} title={key}>
                  <em>{label}</em>{' '}
                  <b className={v < 0 && key !== 'max_drawdown' && key !== 'gross_loss' ? 'neg' : ''}>
                    {cost ? fmtCost(v) : fmt2(v)}
                    {suffix || ''}
                  </b>
                </span>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
