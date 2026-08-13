import { TV } from './theme'

type Props = {
  label: string
  value: string
  hint?: string
  tone?: 'neutral' | 'pos' | 'neg' | 'warn'
  spark?: number[]
  delta?: string
  deltaTone?: 'pos' | 'neg' | 'neutral'
}

function Spark({ values, tone }: { values: number[]; tone: Props['tone'] }) {
  if (!values.length) return null
  const w = 72
  const h = 22
  const pts = values
    .map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * (w - 2) + 1
      const y = h - 2 - v * (h - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const stroke =
    tone === 'pos' ? TV.green : tone === 'neg' ? TV.red : tone === 'warn' ? TV.amber : TV.blue
  return (
    <svg className="metric-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline fill="none" stroke={stroke} strokeWidth="1.5" points={pts} />
    </svg>
  )
}

export function MetricCard({
  label,
  value,
  hint,
  tone = 'neutral',
  spark,
  delta,
  deltaTone = 'neutral',
}: Props) {
  return (
    <div className={`metric-card tone-${tone}`} title={hint || label}>
      <div className="metric-card-top">
        <span className="metric-card-label">{label}</span>
        {spark && spark.length > 1 ? <Spark values={spark} tone={tone} /> : null}
      </div>
      <div className="metric-card-value">{value}</div>
      {delta != null && delta !== '' && (
        <div className={`metric-card-delta delta-${deltaTone}`}>{delta}</div>
      )}
    </div>
  )
}
