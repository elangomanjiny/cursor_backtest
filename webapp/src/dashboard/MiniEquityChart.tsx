/** Fast single-path equity sparkline for optimize leaderboard rows. */
export function MiniEquityChart({
  spark,
  width = 88,
  height = 26,
}: {
  spark?: number[] | null
  width?: number
  height?: number
}) {
  if (!spark || spark.length < 2) {
    return <span className="opt-mini-empty">—</span>
  }

  const min = Math.min(...spark, 0)
  const max = Math.max(...spark, 0)
  const range = Math.max(1e-12, max - min)
  const pad = 1
  const xAt = (i: number) => pad + (i / (spark.length - 1)) * (width - pad * 2)
  const yAt = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2)

  const line = spark.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ')
  const area = `${xAt(0)},${yAt(0)} ${line} ${xAt(spark.length - 1)},${yAt(0)}`
  const endUp = spark[spark.length - 1] >= 0
  const stroke = endUp ? '#22c55e' : '#ef4444'
  const fill = endUp ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.22)'

  return (
    <svg
      className="opt-mini-equity"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
    >
      <polygon points={area} fill={fill} stroke="none" />
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={line}
      />
    </svg>
  )
}
