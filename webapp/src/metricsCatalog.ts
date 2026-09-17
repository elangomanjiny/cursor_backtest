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
      { key: 'avg_ttmfe', label: 'Avg tMFE' },
      { key: 'avg_ttmae', label: 'Avg tMAE' },
      { key: 'avg_dt', label: 'Avg ΔT' },
      { key: 'pct_mae_first', label: '% MAE-first' },
      { key: 'pct_mfe_first', label: '% MFE-first' },
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

export type OptReportCol = {
  key: string
  header: string
  label: string
  section: 'param' | 'equity' | 'metric'
  sortKey?: string
  get?: (r: Record<string, unknown>) => unknown
  format?: 'text' | 'num' | 'time' | 'spark' | 'robust' | 'cost'
}

function strategyLabel(r: Record<string, unknown>): string {
  if (Number(r.pro_mtf_mode)) return 'Pro-MTF'
  if (r.pro_mode) return 'Pro'
  if (r.wait_and_trade) return 'Non-Dir'
  return 'Dir'
}

function beLabel(r: Record<string, unknown>): string {
  return Number(r.break_even) ? 'On' : 'Off'
}

function bePctValue(r: Record<string, unknown>): unknown {
  if (!Number(r.break_even)) return 0
  return r.break_even_pct ?? 0
}

function minsCsv(m: unknown): string {
  const n = Number(m ?? 0)
  if (!Number.isFinite(n)) return ''
  const h = Math.floor(n / 60)
  const mm = Math.abs(n % 60)
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/** Single source of truth: table columns ↔ CSV columns (same order). */
export const OPTIMIZE_REPORT_COLUMNS: OptReportCol[] = [
  { key: 'threshold', header: 'threshold', label: 'Thr', section: 'param', format: 'num' },
  { key: 'rr', header: 'rr', label: 'RR', section: 'param', format: 'num' },
  { key: 'sl_tp_unit', header: 'sl_tp_unit', label: 'SL/TP unit', section: 'param', format: 'text' },
  { key: 'sl_on', header: 'sl_on', label: 'SL on', section: 'param', format: 'num' },
  { key: 'tp_on', header: 'tp_on', label: 'TP on', section: 'param', format: 'num' },
  { key: 'sl_unit', header: 'sl_unit', label: 'SL unit', section: 'param', format: 'text' },
  { key: 'tp_unit', header: 'tp_unit', label: 'TP unit', section: 'param', format: 'text' },
  { key: 'risk_on', header: 'risk_on', label: 'Risk', section: 'param', format: 'num' },
  { key: 'stop_loss', header: 'stop_loss', label: 'SL', section: 'param', format: 'num' },
  { key: 'take_profit', header: 'take_profit', label: 'TP', section: 'param', format: 'num' },
  { key: 'trail_stop', header: 'trail_stop', label: 'Trail', section: 'param', format: 'num' },
  { key: 'trail_unit', header: 'trail_unit', label: 'Trail unit', section: 'param', format: 'text' },
  { key: 'trail_value', header: 'trail_value', label: 'Trail dist', section: 'param', format: 'num' },
  {
    key: 'strategy',
    header: 'strategy',
    label: 'Strategy',
    section: 'param',
    sortKey: '_strategy',
    format: 'text',
    get: strategyLabel,
  },
  { key: 'base_tf', header: 'base_tf', label: 'Base TF', section: 'param', format: 'num' },
  { key: 'base_threshold', header: 'base_threshold', label: 'Base Thr', section: 'param', format: 'num' },
  { key: 'pro_vwap_sigma', header: 'pro_vwap_sigma', label: 'Pro σ', section: 'param', format: 'num' },
  {
    key: 'be',
    header: 'be',
    label: 'BE',
    section: 'param',
    sortKey: '_be',
    format: 'text',
    get: beLabel,
  },
  {
    key: 'break_even_pct',
    header: 'break_even_pct',
    label: 'BE%',
    section: 'param',
    sortKey: '_bePct',
    format: 'num',
    get: bePctValue,
  },
  { key: 'be_unit', header: 'be_unit', label: 'BE unit', section: 'param', format: 'text' },
  { key: 'be_value', header: 'be_value', label: 'BE dist', section: 'param', format: 'num' },
  { key: 'be_ctc', header: 'be_ctc', label: 'CTC', section: 'param', format: 'num' },
  {
    key: 'after',
    header: 'after',
    label: 'After',
    section: 'param',
    sortKey: 'entry_after',
    format: 'time',
    get: (r) => minsCsv(r.entry_after),
  },
  {
    key: 'before',
    header: 'before',
    label: 'Before',
    section: 'param',
    sortKey: 'entry_before',
    format: 'time',
    get: (r) => minsCsv(r.entry_before),
  },
  {
    key: 'flat',
    header: 'flat',
    label: 'Flat',
    section: 'param',
    sortKey: 'exit_time',
    format: 'time',
    get: (r) => minsCsv(r.exit_time),
  },
  { key: 'slippage_pct', header: 'slippage_pct', label: 'Slip%', section: 'param', format: 'num' },
  { key: 'fee_pct', header: 'fee_pct', label: 'Fee%', section: 'param', format: 'num' },
  { key: 'volume', header: 'volume', label: 'Vol', section: 'param', format: 'num' },
  { key: 'equity', header: 'equity_spark', label: 'Equity', section: 'equity', format: 'spark' },
  { key: 'trades', header: 'trades', label: 'Trades', section: 'metric', format: 'num' },
  {
    key: 'total_slippage',
    header: 'total_slippage',
    label: 'Slip $',
    section: 'metric',
    format: 'cost',
  },
  {
    key: 'total_fees',
    header: 'total_fees',
    label: 'Fee $',
    section: 'metric',
    format: 'cost',
  },
  {
    key: 'total_cost',
    header: 'total_cost',
    label: 'Total Cost',
    section: 'metric',
    format: 'cost',
    get: (r) => {
      if (r.total_cost != null && r.total_cost !== '') return Number(r.total_cost)
      return Number(r.total_slippage ?? 0) + Number(r.total_fees ?? 0)
    },
  },
  {
    key: 'gross_profit',
    header: 'gross_profit',
    label: 'Gross+',
    section: 'metric',
    format: 'num',
  },
  {
    key: 'gross_loss',
    header: 'gross_loss',
    label: 'Gross−',
    section: 'metric',
    format: 'num',
  },
  {
    key: 'gross_pnl',
    header: 'gross_pnl',
    label: 'Gross PnL',
    section: 'metric',
    format: 'num',
    get: (r) => {
      if (r.gross_pnl != null && r.gross_pnl !== '') return Number(r.gross_pnl)
      return Number(r.net_pnl ?? 0) + Number(r.total_fees ?? 0)
    },
  },
  { key: 'net_pnl', header: 'net_pnl', label: 'Net PnL', section: 'metric', format: 'num' },
  { key: 'sharpe', header: 'sharpe', label: 'Sharpe', section: 'metric', format: 'num' },
  { key: 'sortino', header: 'sortino', label: 'Sortino', section: 'metric', format: 'num' },
  { key: 'calmar', header: 'calmar', label: 'Calmar', section: 'metric', format: 'num' },
  {
    key: 'profit_factor',
    header: 'profit_factor',
    label: 'Profit Factor',
    section: 'metric',
    format: 'num',
  },
  { key: 'expectancy', header: 'expectancy', label: 'Expectancy', section: 'metric', format: 'num' },
  { key: 'win_rate', header: 'win_rate', label: 'Win%', section: 'metric', format: 'num' },
  {
    key: 'max_drawdown',
    header: 'max_drawdown',
    label: 'Max DD',
    section: 'metric',
    format: 'num',
  },
  { key: 'avg_mfe', header: 'avg_mfe', label: 'Avg MFE', section: 'metric', format: 'num' },
  { key: 'avg_mae', header: 'avg_mae', label: 'Avg MAE', section: 'metric', format: 'num' },
  { key: 'avg_ttmfe', header: 'avg_ttmfe', label: 'Avg tMFE', section: 'metric', format: 'num' },
  { key: 'avg_ttmae', header: 'avg_ttmae', label: 'Avg tMAE', section: 'metric', format: 'num' },
  { key: 'avg_dt', header: 'avg_dt', label: 'Avg ΔT', section: 'metric', format: 'num' },
  { key: 'pct_mae_first', header: 'pct_mae_first', label: '% MAE-first', section: 'metric', format: 'num' },
  { key: 'pct_mfe_first', header: 'pct_mfe_first', label: '% MFE-first', section: 'metric', format: 'num' },
  { key: 'ulcer_index', header: 'ulcer_index', label: 'Ulcer', section: 'metric', format: 'num' },
  {
    key: 'downside_deviation',
    header: 'downside_deviation',
    label: 'Downside Dev',
    section: 'metric',
    format: 'num',
  },
  {
    key: 'max_consec_losses',
    header: 'max_consec_losses',
    label: 'Max Consec L',
    section: 'metric',
    format: 'num',
  },
  {
    key: 'max_consec_wins',
    header: 'max_consec_wins',
    label: 'Max Consec W',
    section: 'metric',
    format: 'num',
  },
  {
    key: 'risk_of_ruin_proxy',
    header: 'risk_of_ruin_proxy',
    label: 'RoR Proxy',
    section: 'metric',
    format: 'num',
  },
  { key: 'avg_win', header: 'avg_win', label: 'Avg Win', section: 'metric', format: 'num' },
  { key: 'avg_loss', header: 'avg_loss', label: 'Avg Loss', section: 'metric', format: 'num' },
  { key: 'payoff_ratio', header: 'payoff_ratio', label: 'Payoff', section: 'metric', format: 'num' },
  { key: 'e_ratio', header: 'e_ratio', label: 'E-ratio', section: 'metric', format: 'num' },
  { key: 'sqn', header: 'sqn', label: 'SQN', section: 'metric', format: 'num' },
  {
    key: 'recovery_factor',
    header: 'recovery_factor',
    label: 'Recovery',
    section: 'metric',
    format: 'num',
  },
  {
    key: 'kelly_fraction',
    header: 'kelly_fraction',
    label: 'Kelly%',
    section: 'metric',
    format: 'num',
  },
  {
    key: 'robustness',
    header: 'robustness_score',
    label: 'Robustness Score',
    section: 'metric',
    sortKey: '_robust',
    format: 'robust',
  },
]

function numish(r: Record<string, unknown>, key: string, fallback = 0): number {
  const v = r[key]
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function slOnRow(r: Record<string, unknown>): boolean {
  return numish(r, 'sl_on', numish(r, 'risk_on', 1)) !== 0
}

function tpOnRow(r: Record<string, unknown>): boolean {
  return numish(r, 'tp_on', numish(r, 'risk_on', 1)) !== 0
}

function unitOf(r: Record<string, unknown>, key: string): string {
  return String(r[key] ?? r.sl_tp_unit ?? 'range')
}

function varied<T>(vals: T[]): boolean {
  return new Set(vals.map((v) => String(v))).size > 1
}

/**
 * Hide unused optimize-result columns for the current run.
 * Off for every row → drop that feature's mode/unit/value columns.
 * On but unused (e.g. SL=range → no SL distance) → drop the unused value.
 */
export function visibleOptimizeColumns(
  rows: Record<string, unknown>[],
): OptReportCol[] {
  if (!rows.length) return OPTIMIZE_REPORT_COLUMNS
  const hide = new Set<string>(['sl_tp_unit', 'risk_on'])

  const slLive = rows.some(slOnRow)
  const tpLive = rows.some(tpOnRow)
  const trailLive = rows.some((r) => numish(r, 'trail_stop') !== 0)
  const beLive = rows.some((r) => numish(r, 'break_even') !== 0)
  const anyPro = rows.some(
    (r) => numish(r, 'pro_mode') !== 0 && numish(r, 'pro_mtf_mode') === 0,
  )
  const anyMtf = rows.some((r) => numish(r, 'pro_mtf_mode') !== 0)

  if (!slLive) {
    hide.add('sl_on')
    hide.add('sl_unit')
    hide.add('stop_loss')
  } else {
    if (!varied(rows.map((r) => (slOnRow(r) ? 1 : 0)))) hide.add('sl_on')
    const anyDist = rows.some((r) => slOnRow(r) && unitOf(r, 'sl_unit') !== 'range')
    if (!anyDist) hide.add('stop_loss')
  }

  if (!tpLive) {
    hide.add('tp_on')
    hide.add('tp_unit')
    hide.add('take_profit')
    hide.add('rr')
  } else {
    if (!varied(rows.map((r) => (tpOnRow(r) ? 1 : 0)))) hide.add('tp_on')
    const anyRange = rows.some((r) => tpOnRow(r) && unitOf(r, 'tp_unit') === 'range')
    const anyDist = rows.some((r) => tpOnRow(r) && unitOf(r, 'tp_unit') !== 'range')
    if (!anyRange) hide.add('rr')
    if (!anyDist) hide.add('take_profit')
  }

  if (!trailLive) {
    hide.add('trail_stop')
    hide.add('trail_unit')
    hide.add('trail_value')
  } else {
    if (!varied(rows.map((r) => numish(r, 'trail_stop')))) hide.add('trail_stop')
    const anyDist = rows.some(
      (r) => numish(r, 'trail_stop') !== 0 && String(r.trail_unit ?? 'range') !== 'range',
    )
    if (!anyDist) hide.add('trail_value')
  }

  if (!beLive) {
    hide.add('be')
    hide.add('break_even_pct')
    hide.add('be_unit')
    hide.add('be_value')
    hide.add('be_ctc')
  } else {
    if (!varied(rows.map((r) => numish(r, 'break_even')))) hide.add('be')
    hide.add('break_even_pct')
    if (!varied(rows.map((r) => numish(r, 'be_ctc')))) hide.add('be_ctc')
    const anyDist = rows.some((r) => {
      if (numish(r, 'break_even') === 0) return false
      const u = String(r.be_unit ?? 'range')
      return u === 'tick' || u === 'points' || u === 'pct'
    })
    if (!anyDist) hide.add('be_value')
  }

  if (!anyPro) hide.add('pro_vwap_sigma')
  if (!anyMtf) {
    hide.add('base_tf')
    hide.add('base_threshold')
  }

  return OPTIMIZE_REPORT_COLUMNS.filter((c) => !hide.has(c.key))
}

function escapeCsv(v: unknown): string {
  const s = String(v ?? '')
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s
}

function triggerCsvDownload(lines: string[], filename: string) {
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadOptimizeCsv(
  rows: Record<string, unknown>[],
  filename = 'optimize-results.csv',
) {
  if (!rows.length) return
  const cols = visibleOptimizeColumns(rows).filter((c) => c.format !== 'spark')
  const headers = cols.map((c) => c.header)
  const lines = [
    headers.join(','),
    ...rows.map((r) =>
      cols
        .map((c) => {
          if (c.format === 'robust') return escapeCsv(r._robust ?? r.robustness_score ?? '')
          if (c.get) return escapeCsv(c.get(r))
          return escapeCsv(r[c.key])
        })
        .join(','),
    ),
  ]
  triggerCsvDownload(lines, filename)
}

type TradeLiteRow = {
  side?: string
  signal_time?: string
  entry_time?: string
  exit_time?: string
  entry_price?: number
  exit_price?: number
  stop?: number
  target?: number
  pnl?: number
  mfe?: number
  mae?: number
  mfe_time?: string | null
  mae_time?: string | null
  slippage?: number
  fee?: number
  volume?: number
  entry_tag?: string
  exit_reason?: string
  be_moved?: boolean
  signal_delta_pct?: number
  range?: number
}

const TRADE_CSV_HEADERS = [
  '#',
  'Side',
  'SignalTime',
  'EntryTime',
  'ExitTime',
  'EntryPrice',
  'ExitPrice',
  'Stop',
  'Target',
  'Points',
  'Lots',
  'Slip',
  'Fee',
  'TotalCost',
  'GrossPnL',
  'PnL',
  'MFE',
  'MAE',
  'tMFE',
  'tMAE',
  'dT',
  'Seq',
  'EntryTag',
  'ExitTag',
  'BE_Moved',
  'Delta%',
  'Range',
] as const

/** Params + metrics (key/value) then a full Trades-tab-style history table. */
export function downloadComboDetailCsv(
  row: Record<string, unknown>,
  filename = 'optimize-combo.csv',
) {
  const lines: string[] = []
  lines.push('PARAMETERS_AND_METRICS')
  lines.push('key,value')
  for (const c of visibleOptimizeColumns([row])) {
    if (c.format === 'spark') continue
    if (c.format === 'robust') {
      lines.push([escapeCsv(c.header), escapeCsv(row._robust ?? row.robustness_score ?? '')].join(','))
      continue
    }
    lines.push([escapeCsv(c.header), escapeCsv(c.get ? c.get(row) : row[c.key])].join(','))
  }

  lines.push('')
  lines.push('TRADE_HISTORY')
  lines.push(TRADE_CSV_HEADERS.join(','))

  const trades = Array.isArray(row.trades_lite) ? (row.trades_lite as TradeLiteRow[]) : []
  if (!trades.length) {
    lines.push('#,note,,,,,,,,,,,,,,,,,,')
    lines.push('1,"No trades_lite on this result — re-run optimize to export full trade history",,,,,,,,,,,,,,,,,,')
  } else {
    trades.forEach((t, i) => {
      const entry = Number(t.entry_price ?? 0)
      const exit = Number(t.exit_price ?? 0)
      const side = String(t.side ?? '')
      const lots = Number(row.volume ?? t.volume ?? 1)
      const points = side.toLowerCase().includes('short') ? entry - exit : exit - entry
      const net = Number(t.pnl ?? 0)
      const slip = Number(t.slippage ?? 0)
      const fee = Number(t.fee ?? 0)
      const gross = net + fee
      const entryMs = t.entry_time ? new Date(t.entry_time).getTime() : NaN
      const mfeMs = t.mfe_time ? new Date(t.mfe_time).getTime() : NaN
      const maeMs = t.mae_time ? new Date(t.mae_time).getTime() : NaN
      const hasDt = Number.isFinite(entryMs) && Number.isFinite(mfeMs) && Number.isFinite(maeMs)
      const dtMin = hasDt ? (mfeMs - maeMs) / 60000 : null
      const seq = dtMin == null ? '' : dtMin > 0 ? 'MAE→' : dtMin < 0 ? 'MFE→' : 'same'
      lines.push(
        [
          i + 1,
          side,
          t.signal_time ?? '',
          t.entry_time ?? '',
          t.exit_time ?? '',
          t.entry_price ?? '',
          t.exit_price ?? '',
          t.stop ?? '',
          t.target ?? '',
          points,
          lots,
          slip,
          fee,
          slip + fee,
          gross,
          net,
          t.mfe ?? '',
          t.mae ?? '',
          t.mfe_time ?? '',
          t.mae_time ?? '',
          dtMin,
          seq,
          t.entry_tag ?? '',
          t.exit_reason ?? '',
          t.be_moved ? 1 : 0,
          t.signal_delta_pct ?? '',
          t.range ?? '',
        ]
          .map(escapeCsv)
          .join(','),
      )
    })
  }

  const spark = Array.isArray(row.equity_spark) ? (row.equity_spark as number[]) : []
  if (spark.length) {
    lines.push('')
    lines.push('EQUITY_SPARK')
    lines.push('step,cum_pnl')
    spark.forEach((v, i) => lines.push(`${i + 1},${escapeCsv(v)}`))
  }

  triggerCsvDownload(lines, filename)
}

/** Column filter: text contains, or numeric >, <, >=, <=, =, min-max */
export function matchColumnFilter(value: unknown, filter: string): boolean {
  const f = filter.trim()
  if (!f) return true
  const num = typeof value === 'number' ? value : Number(value)
  const isNum = Number.isFinite(num) && String(value ?? '').trim() !== '' && String(value) !== '—'

  const op = f.match(/^(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/)
  if (op && isNum) {
    const t = Number(op[2])
    switch (op[1]) {
      case '>':
        return num > t
      case '<':
        return num < t
      case '>=':
        return num >= t
      case '<=':
        return num <= t
      default:
        return num === t
    }
  }
  const range = f.match(/^(-?\d+(?:\.\d+)?)\s*[-:]\s*(-?\d+(?:\.\d+)?)$/)
  if (range && isNum) {
    return num >= Number(range[1]) && num <= Number(range[2])
  }
  if (/^-?\d+(?:\.\d+)?$/.test(f) && isNum) {
    return Math.abs(num - Number(f)) < 1e-9
  }
  return String(value ?? '')
    .toLowerCase()
    .includes(f.toLowerCase())
}
