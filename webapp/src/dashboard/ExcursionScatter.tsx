import { useMemo, useState } from 'react'
import type { TradeRow } from '../api'
import { fmt2 } from '../format'

type Props = {
  trades: TradeRow[]
  symbol?: string
  /** Target distance in price points. Used when Auto is off. */
  targetThreshold?: number | null
  /** Stop distance in price points (plotted as −value on MAE). Used when Auto is off. */
  stopThreshold?: number | null
  showTargetThreshold?: boolean
  showStopThreshold?: boolean
  /** 1.05–1.10 (5–10% SL buffer on winning MAE). */
  slBuffer?: number
  /** Start in auto-calculate mode. */
  autoCalculate?: boolean
}

type Unit = 'price' | 'ticks'

type Pt = { x: number; y: number; win: boolean; short: boolean; tag: string }

type VLine = {
  x: number
  color: string
  label: string
  shadeLeft?: boolean
  shadeColor?: string
}

function tickSize(symbol: string | undefined): number {
  const s = (symbol || '').toUpperCase()
  if (s.startsWith('BTC')) return 0.1
  if (s.startsWith('ETH')) return 0.01
  if (s.startsWith('BNB')) return 0.01
  if (s.startsWith('SOL')) return 0.01
  return 0.01
}

function levelOk(px: number): boolean {
  return Number.isFinite(px) && Math.abs(px) < 1e8
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function deriveThresholds(trades: TradeRow[]): { target: number; stop: number } {
  const targs: number[] = []
  const stops: number[] = []
  for (const t of trades) {
    const entry = Number(t.entry_price)
    const tgt = Number(t.target)
    const stp = Number(t.stop_init ?? t.stop)
    if (levelOk(entry) && levelOk(tgt)) targs.push(Math.abs(tgt - entry))
    if (levelOk(entry) && levelOk(stp)) stops.push(Math.abs(stp - entry))
  }
  return { target: median(targs), stop: median(stops) }
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const idx = (s.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return s[lo]!
  return s[lo]! * (hi - idx) + s[hi]! * (idx - lo)
}

export type AutoThresholds = {
  slTicks: number
  tpTicks: number
  wins: number
  fromWins: boolean
}

/** Winning-trade MAE/MFE engine. SL uses max MAE (p95 if n≥20) × buffer; TP uses min MFE (p25 if n≥20). */
export function computeAutoThresholds(
  trades: TradeRow[],
  tick: number,
  slBuffer = 1.05,
): AutoThresholds | null {
  const ts = tick > 0 ? tick : 0.01
  const buf = Math.min(1.1, Math.max(1.05, slBuffer))
  const wins = trades.filter((t) => Number(t.pnl) > 0)
  const toTicks = (px: number) => Math.abs(px) / ts
  const maes = wins
    .map((t) => toTicks(Number(t.mae ?? 0)))
    .filter((n) => Number.isFinite(n) && n > 0)
  const mfes = wins
    .map((t) => toTicks(Number(t.mfe ?? 0)))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (maes.length || mfes.length) {
    const maeStat = maes.length >= 20 ? percentile(maes, 0.95) : maes.length ? Math.max(...maes) : 0
    const mfeStat = mfes.length >= 20 ? percentile(mfes, 0.25) : mfes.length ? Math.min(...mfes) : 0
    return {
      slTicks: Math.max(0, Math.round(Math.abs(maeStat) * buf)),
      tpTicks: Math.max(0, Math.round(mfeStat)),
      wins: wins.length,
      fromWins: true,
    }
  }
  const fallback = deriveThresholds(trades)
  const sl = Math.round(toTicks(fallback.stop) * buf)
  const tp = Math.round(toTicks(fallback.target))
  if (sl <= 0 && tp <= 0) return null
  return { slTicks: Math.max(0, sl), tpTicks: Math.max(0, tp), wins: 0, fromWins: false }
}

function ScatterPane({
  title,
  xLabel,
  points,
  vline,
}: {
  title: string
  xLabel: string
  points: Pt[]
  vline?: VLine | null
}) {
  const W = 640
  const H = 360
  const pad = { l: 52, r: 16, t: 28, b: 40 }
  const innerW = W - pad.l - pad.r
  const innerH = H - pad.t - pad.b

  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    if (!points.length && !(vline && Number.isFinite(vline.x))) {
      return { xMin: 0, xMax: 1, yMin: -1, yMax: 1 }
    }
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    if (vline && Number.isFinite(vline.x)) xs.push(vline.x)
    const x0 = xs.length ? Math.min(0, ...xs) : 0
    const x1 = xs.length ? Math.max(0, ...xs) : 1
    const y0 = ys.length ? Math.min(0, ...ys) : -1
    const y1 = ys.length ? Math.max(0, ...ys) : 1
    const xPad = Math.max(1e-6, (x1 - x0) * 0.08)
    const yPad = Math.max(1e-6, (y1 - y0) * 0.08)
    return { xMin: x0 - xPad, xMax: x1 + xPad, yMin: y0 - yPad, yMax: y1 + yPad }
  }, [points, vline])

  const sx = (x: number) => pad.l + ((x - xMin) / (xMax - xMin || 1)) * innerW
  const sy = (y: number) => pad.t + (1 - (y - yMin) / (yMax - yMin || 1)) * innerH
  const y0 = sy(0)
  const x0 = sx(0)

  const ticks = (lo: number, hi: number, n = 5) => {
    const out: number[] = []
    for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n)
    return out
  }

  const vX = vline && Number.isFinite(vline.x) ? sx(vline.x) : null
  const labelLeft = vX != null && vX > pad.l + innerW * 0.62

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
          {vline && vX != null && (
            <g>
              {vline.shadeLeft && (
                <rect
                  x={pad.l}
                  y={pad.t}
                  width={Math.max(0, Math.min(innerW, vX - pad.l))}
                  height={innerH}
                  fill={vline.shadeColor || 'rgba(255, 82, 82, 0.08)'}
                />
              )}
              <line
                x1={vX}
                x2={vX}
                y1={pad.t}
                y2={H - pad.b}
                stroke={vline.color}
                strokeWidth={1.75}
                strokeDasharray="5 4"
              />
              <text
                x={labelLeft ? vX - 6 : vX + 6}
                y={pad.t + 12}
                fill={vline.color}
                fontSize={10}
                fontFamily="ui-monospace, monospace"
                textAnchor={labelLeft ? 'end' : 'start'}
              >
                {vline.label}
              </text>
            </g>
          )}
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

export function ExcursionScatter({
  trades,
  symbol,
  targetThreshold = null,
  stopThreshold = null,
  showTargetThreshold = true,
  showStopThreshold = true,
  slBuffer = 1.05,
  autoCalculate = true,
}: Props) {
  const [unit, setUnit] = useState<Unit>('ticks')
  const [autoOn, setAutoOn] = useState(autoCalculate)
  const [targetOn, setTargetOn] = useState(showTargetThreshold)
  const [stopOn, setStopOn] = useState(showStopThreshold)
  const [targetOverride, setTargetOverride] = useState<number | null>(null)
  const [stopOverride, setStopOverride] = useState<number | null>(null)
  const [bufferPct, setBufferPct] = useState(() => {
    const p = Math.round((slBuffer - 1) * 100)
    return Math.min(10, Math.max(5, p || 5))
  })
  const tick = tickSize(symbol)

  const auto = useMemo(
    () => computeAutoThresholds(trades, tick, 1 + bufferPct / 100),
    [trades, tick, bufferPct],
  )
  const derived = useMemo(() => deriveThresholds(trades), [trades])

  const autoStopPx = auto && auto.slTicks > 0 ? auto.slTicks * tick : 0
  const autoTargetPx = auto && auto.tpTicks > 0 ? auto.tpTicks * tick : 0
  const targetPx = autoOn
    ? autoTargetPx || (targetOverride ?? targetThreshold ?? derived.target)
    : (targetOverride ?? targetThreshold ?? derived.target)
  const stopPx = autoOn
    ? autoStopPx || (stopOverride ?? stopThreshold ?? derived.stop)
    : (stopOverride ?? stopThreshold ?? derived.stop)
  const toUnit = (px: number) => (unit === 'ticks' && tick > 0 ? px / tick : px)

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
  const showTarget = autoOn ? targetPx > 0 : targetOn && targetPx > 0
  const showStop = autoOn ? stopPx > 0 : stopOn && stopPx > 0
  const targetLine: VLine | null = showTarget
    ? {
        x: toUnit(targetPx),
        color: '#00e676',
        label: 'Target Threshold',
      }
    : null
  const stopLine: VLine | null = showStop
    ? {
        x: -toUnit(stopPx),
        color: '#ff5252',
        label: 'Hard Stop Cutoff',
        shadeLeft: true,
        shadeColor: 'rgba(255, 82, 82, 0.08)',
      }
    : null

  const slBadge = autoOn && auto ? -auto.slTicks : Math.round(-toUnit(stopPx))
  const tpBadge = autoOn && auto ? auto.tpTicks : Math.round(toUnit(targetPx))

  return (
    <div className="excursion-grid">
      <div className="excursion-toolbar">
        <div className="excursion-ref-fields">
          <label
            className="check"
            title="SL from winning MAE (max, or 95th pct if ≥20 wins) × buffer. TP from winning MFE (min, or 25th pct if ≥20)."
          >
            <input
              type="checkbox"
              checked={autoOn}
              onChange={(e) => setAutoOn(e.target.checked)}
            />
            Auto-Calculate Thresholds
          </label>
          {autoOn ? (
            <>
              <label title="5–10% buffer added to winning MAE for the hard-stop line">
                Buffer
                <input
                  className="num-plain"
                  type="number"
                  min={5}
                  max={10}
                  step={1}
                  value={bufferPct}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (!Number.isFinite(n)) return
                    setBufferPct(Math.min(10, Math.max(5, Math.round(n))))
                  }}
                  aria-label="SL buffer percent"
                />
                %
              </label>
              <span
                className={`excursion-auto-badge${auto?.fromWins ? '' : ' muted'}`}
                title={
                  auto?.fromWins
                    ? `${auto.wins} winning trades`
                    : 'No winning trades — using default SL/TP distances'
                }
              >
                Auto SL: {slBadge} ticks | Auto TP: {tpBadge} ticks
              </span>
            </>
          ) : (
            <>
              <label title="Vertical green dashed line on MFE vs PnL">
                <input
                  type="checkbox"
                  checked={targetOn}
                  onChange={(e) => setTargetOn(e.target.checked)}
                />
                Target
                <input
                  className="num-plain"
                  type="number"
                  min={0}
                  step={unit === 'ticks' ? '1' : '0.01'}
                  value={Number.isFinite(toUnit(targetPx)) ? Number(toUnit(targetPx).toFixed(2)) : 0}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (!Number.isFinite(n) || n < 0) return
                    const px = unit === 'ticks' && tick > 0 ? n * tick : n
                    setTargetOverride(px)
                  }}
                  aria-label="Target threshold"
                />
              </label>
              <label title="Vertical red dashed line + shade on MAE vs PnL">
                <input
                  type="checkbox"
                  checked={stopOn}
                  onChange={(e) => setStopOn(e.target.checked)}
                />
                Stop
                <input
                  className="num-plain"
                  type="number"
                  min={0}
                  step={unit === 'ticks' ? '1' : '0.01'}
                  value={Number.isFinite(toUnit(stopPx)) ? Number(toUnit(stopPx).toFixed(2)) : 0}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (!Number.isFinite(n) || n < 0) return
                    const px = unit === 'ticks' && tick > 0 ? n * tick : n
                    setStopOverride(px)
                  }}
                  aria-label="Stop-loss threshold"
                />
              </label>
            </>
          )}
        </div>
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
      <ScatterPane
        title="MFE vs PnL"
        xLabel={`MFE (${unitLab})`}
        points={mfePts}
        vline={targetLine}
      />
      <ScatterPane
        title="MAE vs PnL"
        xLabel={`MAE (${unitLab}, signed)`}
        points={maePts}
        vline={stopLine}
      />
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
