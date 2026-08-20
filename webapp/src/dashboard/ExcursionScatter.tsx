import { useMemo, useState } from 'react'
import type { TradeRow } from '../api'
import { fmt2 } from '../format'

type Props = {
  trades: TradeRow[]
  symbol?: string
}

type Unit = 'price' | 'ticks'

type Pt = { x: number; y: number; win: boolean; short: boolean; tag: string }

function tickSize(symbol: string | undefined): number {
  const s = (symbol || '').toUpperCase()
  if (s.startsWith('BTC')) return 0.1
  if (s.startsWith('ETH')) return 0.01
  if (s.startsWith('BNB')) return 0.01
  if (s.startsWith('SOL')) return 0.01
  return 0.01
}

function ScatterPane({
  title,
  xLabel,
  points,
}: {
  title: string
  xLabel: string
  points: Pt[]
}) {
  const W = 640
  const H = 360
  const pad = { l: 52, r: 16, t: 28, b: 40 }
  const innerW = W - pad.l - pad.r
  const innerH = H - pad.t - pad.b

  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    if (!points.length) return { xMin: 0, xMax: 1, yMin: -1, yMax: 1 }
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const x0 = Math.min(0, ...xs)
    const x1 = Math.max(0, ...xs)
    const y0 = Math.min(0, ...ys)
    const y1 = Math.max(0, ...ys)
    const xPad = Math.max(1e-6, (x1 - x0) * 0.08)
    const yPad = Math.max(1e-6, (y1 - y0) * 0.08)
    return { xMin: x0 - xPad, xMax: x1 + xPad, yMin: y0 - yPad, yMax: y1 + yPad }
  }, [points])

  const sx = (x: number) => pad.l + ((x - xMin) / (xMax - xMin || 1)) * innerW
  const sy = (y: number) => pad.t + (1 - (y - yMin) / (yMax - yMin || 1)) * innerH
  const y0 = sy(0)
  const x0 = sx(0)

  const ticks = (lo: number, hi: number, n = 5) => {
    const out: number[] = []
    for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n)
    return out
  }

  return (
    <div className="excursion-pane">
      <h3>{title}</h3>
      {points.length ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="excursion-svg" role="img" aria-label={title}>
          <rect x={pad.l} y={pad.t} width={innerW} height={innerH} className="excursion-plot-bg" />
          {ticks(yMin, yMax).map((v) => (
            <g key={`y${v}`}>
              <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} className="excursion-grid" />
              <text x={pad.l - 6} y={sy(v) + 3} className="excursion-tick" textAnchor="end">
                {fmt2(v)}
              </text>
            </g>
          ))}
          {ticks(xMin, xMax).map((v) => (
            <g key={`x${v}`}>
              <line y1={pad.t} y2={H - pad.b} x1={sx(v)} x2={sx(v)} className="excursion-grid" />
              <text x={sx(v)} y={H - pad.b + 16} className="excursion-tick" textAnchor="middle">
                {fmt2(v)}
              </text>
            </g>
          ))}
          <line x1={pad.l} x2={W - pad.r} y1={y0} y2={y0} className="excursion-axis" />
          <line y1={pad.t} y2={H - pad.b} x1={x0} x2={x0} className="excursion-axis" />
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
              <title>{`${p.tag} · ${xLabel} ${fmt2(p.x)} · PnL ${fmt2(p.y)}`}</title>
            </circle>
          ))}
          <text x={W / 2} y={H - 8} className="excursion-axis-lab" textAnchor="middle">
            {xLabel}
          </text>
          <text
            x={14}
            y={H / 2}
            className="excursion-axis-lab"
            textAnchor="middle"
            transform={`rotate(-90 14 ${H / 2})`}
          >
            PnL
          </text>
        </svg>
      ) : (
        <p className="hint">No trades to plot.</p>
      )}
    </div>
  )
}

export function ExcursionScatter({ trades, symbol }: Props) {
  const [unit, setUnit] = useState<Unit>('price')
  const tick = tickSize(symbol)

  const { mfePts, maePts } = useMemo(() => {
    const scale = (price: number) => (unit === 'ticks' && tick > 0 ? price / tick : price)
    const mfe: Pt[] = []
    const mae: Pt[] = []
    for (const t of trades) {
      const win = Number(t.pnl) > 0
      const short = String(t.side).toLowerCase().includes('short')
      const tag = String(t.entry_tag || t.side || '')
      const y = Number(t.pnl)
      mfe.push({
        x: scale(Math.abs(Number(t.mfe ?? 0))),
        y,
        win,
        short,
        tag,
      })
      mae.push({
        x: -scale(Math.abs(Number(t.mae ?? 0))),
        y,
        win,
        short,
        tag,
      })
    }
    return { mfePts: mfe, maePts: mae }
  }, [trades, unit, tick])

  const unitLab = unit === 'ticks' ? 'ticks' : 'price (points)'

  return (
    <div className="excursion-grid">
      <div className="excursion-toolbar">
        <span className="hint" style={{ margin: 0 }}>
          Engine stores MFE/MAE as price. MAE is plotted negative (adverse).
        </span>
        <div className="equity-side-filters" role="group" aria-label="Excursion unit">
          <button
            type="button"
            className={`equity-side-btn${unit === 'price' ? ' on' : ''}`}
            onClick={() => setUnit('price')}
          >
            Price
          </button>
          <button
            type="button"
            className={`equity-side-btn${unit === 'ticks' ? ' on' : ''}`}
            onClick={() => setUnit('ticks')}
          >
            Ticks
          </button>
        </div>
      </div>
      <ScatterPane title="MFE vs PnL" xLabel={`MFE (${unitLab})`} points={mfePts} />
      <ScatterPane title="MAE vs PnL" xLabel={`MAE (${unitLab}, signed)`} points={maePts} />
      <p className="excursion-legend">
        <span>
          <i style={{ background: '#22c55e' }} /> Win
        </span>
        <span>
          <i style={{ background: '#ef4444' }} /> Loss
        </span>
        <span>Green ring = Long · Red ring = Short · MAE left of 0 = adverse</span>
      </p>
    </div>
  )
}
