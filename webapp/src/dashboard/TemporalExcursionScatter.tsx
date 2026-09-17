import { useMemo, useState } from 'react'
import type { TradeRow } from '../api'
import { fmt2 } from '../format'
import { tradeExcursionTiming } from './excursionTiming'

type Props = {
  trades: TradeRow[]
  tfMinutes: number
}

type Unit = 'minutes' | 'bars'

type Pt = {
  x: number
  y: number
  win: boolean
  short: boolean
  tag: string
}

const W = 640
const H = 280
const pad = { t: 18, r: 16, b: 36, l: 46 }

export function TemporalExcursionScatter({ trades, tfMinutes }: Props) {
  const [unit, setUnit] = useState<Unit>('bars')

  const points = useMemo(() => {
    const out: Pt[] = []
    for (const t of trades) {
      const timing = tradeExcursionTiming(t, tfMinutes)
      const x = unit === 'bars' ? timing.tMaeBars : timing.tMaeMin
      const y = unit === 'bars' ? timing.tMfeBars : timing.tMfeMin
      if (x == null || y == null) continue
      out.push({
        x,
        y,
        win: Number(t.pnl) > 0,
        short: String(t.side).toLowerCase().includes('short'),
        tag: `${t.side} ${t.entry_tag || ''} ΔT ${
          timing.dtMin == null ? '—' : fmt2(timing.dtMin)
        }m`,
      })
    }
    return out
  }, [trades, tfMinutes, unit])

  const { xMax, yMax } = useMemo(() => {
    let xm = 1
    let ym = 1
    for (const p of points) {
      xm = Math.max(xm, p.x)
      ym = Math.max(ym, p.y)
    }
    const lim = Math.max(xm, ym) * 1.08
    return { xMax: lim, yMax: lim }
  }, [points])

  const innerW = W - pad.l - pad.r
  const innerH = H - pad.t - pad.b
  const sx = (v: number) => pad.l + (v / xMax) * innerW
  const sy = (v: number) => pad.t + innerH - (v / yMax) * innerH
  const unitLab = unit === 'bars' ? 'bars' : 'min'

  const ticks = (hi: number, n = 4) => {
    const out: number[] = []
    for (let i = 0; i <= n; i++) out.push((hi * i) / n)
    return out
  }

  return (
    <div className="temporal-exc">
      <div className="temporal-exc-toolbar">
        <div className="equity-side-filters" role="group" aria-label="Time unit">
          <button
            type="button"
            className={unit === 'bars' ? 'active' : ''}
            onClick={() => setUnit('bars')}
          >
            Bars
          </button>
          <button
            type="button"
            className={unit === 'minutes' ? 'active' : ''}
            onClick={() => setUnit('minutes')}
          >
            Minutes
          </button>
        </div>
        <span className="temporal-exc-count">
          {points.length} / {trades.length} trades with both extremes
        </span>
      </div>
      {points.length ? (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="excursion-svg temporal-exc-svg"
          role="img"
          aria-label="Time to MAE vs Time to MFE"
        >
          <rect x={pad.l} y={pad.t} width={innerW} height={innerH} className="excursion-plot-bg" />
          {ticks(yMax).map((v) => (
            <g key={`y${v}`}>
              <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} className="excursion-grid" />
              <text x={pad.l - 6} y={sy(v) + 3} className="excursion-tick" textAnchor="end">
                {fmt2(v)}
              </text>
            </g>
          ))}
          {ticks(xMax).map((v) => (
            <g key={`x${v}`}>
              <line y1={pad.t} y2={H - pad.b} x1={sx(v)} x2={sx(v)} className="excursion-grid" />
              <text x={sx(v)} y={H - pad.b + 16} className="excursion-tick" textAnchor="middle">
                {fmt2(v)}
              </text>
            </g>
          ))}
          <line
            x1={sx(0)}
            y1={sy(0)}
            x2={sx(Math.min(xMax, yMax))}
            y2={sy(Math.min(xMax, yMax))}
            className="temporal-exc-diag"
          />
          <text
            x={sx(Math.min(xMax, yMax) * 0.72)}
            y={sy(Math.min(xMax, yMax) * 0.72) - 6}
            className="temporal-exc-diag-lab"
          >
            ΔT = 0
          </text>
          {points.map((p, i) => (
            <circle
              key={i}
              cx={sx(p.x)}
              cy={sy(p.y)}
              r={4.2}
              fill={p.win ? '#22c55e' : '#ef4444'}
              fillOpacity={0.85}
              stroke={p.short ? '#f85149' : '#3fb950'}
              strokeWidth={1}
            >
              <title>{`${p.tag} · tMAE ${fmt2(p.x)} · tMFE ${fmt2(p.y)}`}</title>
            </circle>
          ))}
          <text x={W / 2} y={H - 8} className="excursion-axis-lab" textAnchor="middle">
            {`Time to MAE (${unitLab})`}
          </text>
          <text
            x={14}
            y={H / 2}
            className="excursion-axis-lab"
            textAnchor="middle"
            transform={`rotate(-90 14 ${H / 2})`}
          >
            {`Time to MFE (${unitLab})`}
          </text>
        </svg>
      ) : (
        <p className="hint">Run a backtest to plot first-touch MFE / MAE times.</p>
      )}
      <p className="excursion-legend temporal-exc-legend">
        <span>Above 45° (Y &gt; X): MAE first — early drawdown, then the run</span>
        <span>Below 45° (Y &lt; X): MFE first — green first, then giveback</span>
        <span>Green fill = win · Red fill = loss · Green ring = Long · Red ring = Short</span>
      </p>
    </div>
  )
}
