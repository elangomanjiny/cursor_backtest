import { useMemo, useState } from 'react'
import type { OptimizePoint } from '../api'
import { comboKey, flagOverfitRisk } from './overfitHeuristic'
import { fmt2 } from '../format'
import { TV } from './theme'

type MetricKey = 'sharpe' | 'net_pnl' | 'profit_factor' | 'win_rate' | 'max_drawdown' | 'sqn'

type Props = {
  results: OptimizePoint[]
  onSelect: (point: OptimizePoint) => void
  selectedKey?: string | null
}

const METRICS: { key: MetricKey; label: string; higherBetter: boolean }[] = [
  { key: 'sharpe', label: 'Sharpe', higherBetter: true },
  { key: 'net_pnl', label: 'Net PnL', higherBetter: true },
  { key: 'profit_factor', label: 'PF', higherBetter: true },
  { key: 'win_rate', label: 'Win%', higherBetter: true },
  { key: 'max_drawdown', label: 'Max DD', higherBetter: false },
  { key: 'sqn', label: 'SQN', higherBetter: true },
]

function cellColor(v: number, min: number, max: number, higherBetter: boolean): string {
  if (!Number.isFinite(v) || max === min) return TV.grid
  let t = (v - min) / (max - min)
  if (!higherBetter) t = 1 - t
  t = Math.max(0, Math.min(1, t))
  // teal → amber → red-ish for low
  const r = Math.round(38 + (239 - 38) * (1 - t))
  const g = Math.round(166 + (83 - 166) * (1 - t))
  const b = Math.round(154 + (80 - 154) * (1 - t))
  const a = 0.25 + t * 0.7
  return `rgba(${r},${g},${b},${a})`
}

export function OptimizeHeatmap({ results, onSelect, selectedKey }: Props) {
  const [metric, setMetric] = useState<MetricKey>('sharpe')
  const overfit = useMemo(() => flagOverfitRisk(results), [results])
  const meta = METRICS.find((m) => m.key === metric)!

  const grid = useMemo(() => {
    const ths = [...new Set(results.map((r) => Number(r.threshold)))].sort((a, b) => a - b)
    const rrs = [...new Set(results.map((r) => Number(r.rr)))].sort((a, b) => a - b)
    const map = new Map<string, OptimizePoint>()
    for (const r of results) {
      // Prefer best sharpe when multiple combos share thr×rr (BE/slip variants)
      const k = `${r.threshold}|${r.rr}`
      const prev = map.get(k)
      if (!prev || Number(r[metric] ?? 0) > Number(prev[metric] ?? 0)) map.set(k, r)
    }
    const vals = [...map.values()].map((r) => Number(r[metric] ?? 0))
    const min = Math.min(...vals, 0)
    const max = Math.max(...vals, 0)
    return { ths, rrs, map, min, max }
  }, [results, metric])

  if (grid.ths.length < 1 || grid.rrs.length < 1) {
    return <p className="hint">Not enough grid points for a heatmap.</p>
  }

  return (
    <div className="opt-heatmap">
      <div className="opt-heatmap-head">
        <span className="strip-lab">PARAM HEATMAP — Thr × RR</span>
        <label>
          Color by
          <select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}>
            {METRICS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <span className="hint" style={{ margin: 0 }}>
          Click a cell to load that combo into backtest equity. Hatched border = overfit-risk
          heuristic (high Sharpe, thin sample / heavy DD) — not true OOS.
        </span>
      </div>
      <div className="opt-heatmap-scroll">
        <table className="opt-heatmap-table">
          <thead>
            <tr>
              <th>RR \\ Thr</th>
              {grid.ths.map((th) => (
                <th key={th}>{fmt2(th)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rrs.map((rr) => (
              <tr key={rr}>
                <th>{fmt2(rr)}</th>
                {grid.ths.map((th) => {
                  const point = grid.map.get(`${th}|${rr}`)
                  if (!point) {
                    return <td key={th} className="empty" />
                  }
                  const v = Number(point[metric] ?? 0)
                  const key = comboKey(point)
                  const risk = overfit.has(key)
                  const sel = selectedKey === key
                  return (
                    <td key={th}>
                      <button
                        type="button"
                        className={`opt-heat-cell${risk ? ' overfit' : ''}${sel ? ' selected' : ''}`}
                        style={{
                          background: cellColor(v, grid.min, grid.max, meta.higherBetter),
                        }}
                        title={`thr=${th} RR=${rr} ${meta.label}=${fmt2(v)}${risk ? ' · overfit risk' : ''}`}
                        onClick={() => onSelect(point)}
                      >
                        {fmt2(v)}
                        {risk ? <span className="overfit-dot" /> : null}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
