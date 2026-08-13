/** Shared metric category definitions + CSV helpers (mirrors backend). */
export const METRIC_CATEGORIES: {
  name: string
  keys: { key: string; label: string }[]
}[] = [
  {
    name: 'Risk',
    keys: [
      { key: 'max_drawdown', label: 'Max DD' },
      { key: 'avg_mae', label: 'Avg MAE' },
      { key: 'ulcer_index', label: 'Ulcer index' },
      { key: 'downside_deviation', label: 'Downside dev' },
      { key: 'max_consec_losses', label: 'Max consec losses' },
      { key: 'risk_of_ruin_proxy', label: 'RoR proxy' },
    ],
  },
  {
    name: 'Trading',
    keys: [
      { key: 'trades', label: 'Trades' },
      { key: 'win_rate', label: 'Win %' },
      { key: 'expectancy', label: 'Expectancy' },
      { key: 'avg_win', label: 'Avg win' },
      { key: 'avg_loss', label: 'Avg loss' },
      { key: 'payoff_ratio', label: 'Payoff' },
      { key: 'avg_mfe', label: 'Avg MFE' },
      { key: 'e_ratio', label: 'E-ratio' },
      { key: 'max_consec_wins', label: 'Max consec wins' },
    ],
  },
  {
    name: 'Money management',
    keys: [
      { key: 'net_pnl', label: 'Net PnL' },
      { key: 'gross_profit', label: 'Gross profit' },
      { key: 'gross_loss', label: 'Gross loss' },
      { key: 'profit_factor', label: 'Profit factor' },
      { key: 'recovery_factor', label: 'Recovery factor' },
      { key: 'kelly_fraction', label: 'Kelly %' },
      { key: 'avg_trade', label: 'Avg trade' },
    ],
  },
  {
    name: 'Strategy',
    keys: [
      { key: 'sqn', label: 'SQN' },
      { key: 'sharpe', label: 'Sharpe' },
      { key: 'sortino', label: 'Sortino' },
      { key: 'calmar', label: 'Calmar' },
      { key: 'e_ratio', label: 'E-ratio' },
      { key: 'win_rate', label: 'Win %' },
    ],
  },
]

export function downloadOptimizeCsv(
  rows: Record<string, unknown>[],
  filename = 'optimize-results.csv',
) {
  if (!rows.length) return
  const paramCols = ['threshold', 'rr', 'wait_and_trade', 'break_even', 'break_even_pct']
  const metricCols = Array.from(
    new Set(METRIC_CATEGORIES.flatMap((c) => c.keys.map((k) => k.key))),
  )
  const headers = [...paramCols, ...metricCols]
  const escape = (v: unknown) => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
