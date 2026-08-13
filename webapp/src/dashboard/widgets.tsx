import { FT } from './theme'
import type { MonthlyCell } from './computeDashboard'
import { fmt2 } from '../format'

export function Sparkline({
  values,
  stroke = FT.cyan,
  fill,
  height = 28,
  width = 96,
}: {
  values: number[]
  stroke?: string
  fill?: string
  height?: number
  width?: number
}) {
  if (!values.length) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * (width - 2) + 1
    const y = height - 2 - ((v - min) / span) * (height - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const line = pts.join(' ')
  const area = `1,${height - 1} ${line} ${width - 1},${height - 1}`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="pod-spark">
      {fill ? <polygon points={area} fill={fill} /> : null}
      <polyline fill="none" stroke={stroke} strokeWidth="1.6" points={line} />
    </svg>
  )
}

export function WinRateGauge({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct))
  const r = 28
  const c = 2 * Math.PI * r
  const dash = (p / 100) * c
  return (
    <svg width="72" height="44" viewBox="0 0 72 44" aria-hidden className="pod-gauge">
      <path
        d="M8 40 A28 28 0 0 1 64 40"
        fill="none"
        stroke="rgba(100,130,160,0.25)"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <path
        d="M8 40 A28 28 0 0 1 64 40"
        fill="none"
        stroke={p >= 50 ? FT.neon : FT.crimson}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`}
      />
    </svg>
  )
}

export function Donut({ pct, size = 56 }: { pct: number; size?: number }) {
  const p = Math.max(0, Math.min(100, pct))
  const r = 18
  const c = 2 * Math.PI * r
  const dash = (p / 100) * c
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <circle cx="24" cy="24" r={r} fill="none" stroke="rgba(100,130,160,0.22)" strokeWidth="6" />
      <circle
        cx="24"
        cy="24"
        r={r}
        fill="none"
        stroke={FT.azure}
        strokeWidth="6"
        strokeDasharray={`${dash} ${c}`}
        strokeLinecap="round"
        transform="rotate(-90 24 24)"
      />
      <text x="24" y="27" textAnchor="middle" fontSize="9" fill={FT.text} fontWeight="600">
        {fmt2(p)}%
      </text>
    </svg>
  )
}

export function MetricRow({
  icon,
  label,
  value,
  spark,
  sparkStroke,
}: {
  icon: string
  label: string
  value: string
  spark?: number[]
  sparkStroke?: string
}) {
  return (
    <div className="pod-metric-row">
      <span className="pod-metric-ico" aria-hidden>
        {icon}
      </span>
      <span className="pod-metric-lab">{label}</span>
      {spark && spark.length > 1 ? (
        <Sparkline values={spark} stroke={sparkStroke || FT.cyan} width={64} height={20} />
      ) : (
        <span />
      )}
      <span className="pod-metric-val">{value}</span>
    </div>
  )
}

/** Visualize max consecutive streak lengths (not trade counts). */
export function StreakBars({ wins, losses }: { wins: number; losses: number }) {
  const max = Math.max(wins, losses, 1)
  return (
    <div className="pod-streaks">
      <div className="pod-streak">
        <span title="Longest consecutive winning streak (not number of winning trades)">
          Max win streak {wins}
        </span>
        <div className="pod-streak-track">
          <div className="pod-streak-fill win" style={{ width: `${(100 * wins) / max}%` }} />
        </div>
      </div>
      <div className="pod-streak">
        <span title="Longest consecutive losing streak (not number of losing trades)">
          Max loss streak {losses}
        </span>
        <div className="pod-streak-track">
          <div className="pod-streak-fill loss" style={{ width: `${(100 * losses) / max}%` }} />
        </div>
      </div>
    </div>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function MonthlyHeatmap({ cells }: { cells: MonthlyCell[] }) {
  const years = [...new Set(cells.map((c) => c.year))].sort()
  const byKey = new Map(cells.map((c) => [`${c.year}-${c.month}`, c]))
  const absMax = Math.max(1, ...cells.map((c) => Math.abs(c.returnPct)))

  if (!years.length) {
    return <p className="pod-muted">No monthly return samples yet.</p>
  }

  return (
    <div className="pod-month-heat">
      <div className="pod-month-heat-head">
        <span />
        {MONTHS.map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>
      {years.map((y) => (
        <div key={y} className="pod-month-heat-row">
          <span className="pod-month-y">{y}</span>
          {MONTHS.map((_, m) => {
            const cell = byKey.get(`${y}-${m}`)
            if (!cell) {
              return <span key={m} className="pod-month-cell empty" />
            }
            const t = cell.returnPct / absMax
            const bg =
              cell.returnPct >= 0
                ? `rgba(34, 197, 94, ${0.15 + Math.abs(t) * 0.75})`
                : `rgba(239, 68, 68, ${0.15 + Math.abs(t) * 0.75})`
            return (
              <span
                key={m}
                className="pod-month-cell"
                style={{ background: bg }}
                title={`${MONTHS[m]} ${y}: ${fmt2(cell.returnPct)}% · ${cell.trades} trades`}
              >
                {fmt2(cell.returnPct)}
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}
