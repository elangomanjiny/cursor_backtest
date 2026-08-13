import { useEffect, useMemo, useState } from 'react'
import type { OptimizePoint } from '../api'
import { comboKey, flagOverfitRisk } from './overfitHeuristic'
import { fmt2 } from '../format'
import { TV } from './theme'

type MetricKey = 'sharpe' | 'net_pnl' | 'win_rate' | 'max_drawdown' | 'profit_factor'
type AxisMode = 'thr_rr' | 'time_thr' | 'time_rr'

type Props = {
  results: OptimizePoint[]
  onSelect: (point: OptimizePoint) => void
  selectedKey?: string | null
  /** Prefer time surfaces when time-optimizer produced multiple After starts */
  preferTimeSurface?: boolean
}

const METRICS: { key: MetricKey; label: string; higherBetter: boolean }[] = [
  { key: 'sharpe', label: 'Sharpe', higherBetter: true },
  { key: 'net_pnl', label: 'Net PnL', higherBetter: true },
  { key: 'win_rate', label: 'Win %', higherBetter: true },
  { key: 'max_drawdown', label: 'MaxDD', higherBetter: false },
  { key: 'profit_factor', label: 'PF', higherBetter: true },
]

function minsLabel(m: number): string {
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function cellColor(v: number, min: number, max: number, higherBetter: boolean): string {
  if (!Number.isFinite(v) || max === min) return TV.grid
  let t = (v - min) / (max - min)
  if (!higherBetter) t = 1 - t
  t = Math.max(0, Math.min(1, t))
  const r = Math.round(38 + (239 - 38) * (1 - t))
  const g = Math.round(166 + (83 - 166) * (1 - t))
  const b = Math.round(154 + (80 - 154) * (1 - t))
  const a = 0.25 + t * 0.7
  return `rgba(${r},${g},${b},${a})`
}

function pickBetter(
  a: OptimizePoint | undefined,
  b: OptimizePoint,
  metric: MetricKey,
  higherBetter: boolean,
): OptimizePoint {
  if (!a) return b
  const av = Number(a[metric] ?? 0)
  const bv = Number(b[metric] ?? 0)
  if (higherBetter) return bv > av ? b : a
  return bv < av ? b : a
}

export function OptimizeHeatmap({
  results,
  onSelect,
  selectedKey,
  preferTimeSurface = false,
}: Props) {
  const [metric, setMetric] = useState<MetricKey>('sharpe')
  const overfit = useMemo(() => flagOverfitRisk(results), [results])
  const meta = METRICS.find((m) => m.key === metric)!

  const hasTimeAxis = useMemo(() => {
    const times = new Set(results.map((r) => Number(r.entry_after ?? 0)))
    return times.size > 1
  }, [results])

  const thrCount = useMemo(
    () => new Set(results.map((r) => Number(r.threshold))).size,
    [results],
  )
  const rrCount = useMemo(() => new Set(results.map((r) => Number(r.rr))).size, [results])
  const sparseThrRr = thrCount <= 1 && rrCount <= 1

  const [axis, setAxis] = useState<AxisMode>('thr_rr')

  useEffect(() => {
    if (!hasTimeAxis) {
      setAxis('thr_rr')
      return
    }
    if (preferTimeSurface || sparseThrRr) {
      setAxis(thrCount > 1 ? 'time_thr' : 'time_rr')
    }
  }, [hasTimeAxis, preferTimeSurface, sparseThrRr, thrCount])

  const activeAxis: AxisMode =
    hasTimeAxis && (axis === 'time_thr' || axis === 'time_rr') ? axis : 'thr_rr'

  const grid = useMemo(() => {
    if (activeAxis === 'time_thr') {
      const times = [...new Set(results.map((r) => Number(r.entry_after ?? 0)))].sort((a, b) => a - b)
      const ths = [...new Set(results.map((r) => Number(r.threshold)))].sort((a, b) => a - b)
      const map = new Map<string, OptimizePoint>()
      for (const r of results) {
        const k = `${r.entry_after ?? 0}|${r.threshold}`
        map.set(k, pickBetter(map.get(k), r, metric, meta.higherBetter))
      }
      const vals = [...map.values()].map((r) => Number(r[metric] ?? 0))
      return {
        mode: 'time_thr' as const,
        rows: times,
        cols: ths,
        map,
        min: Math.min(...vals, 0),
        max: Math.max(...vals, 0),
        colFmt: 'num' as const,
        rowFmt: 'time' as const,
      }
    }

    if (activeAxis === 'time_rr') {
      const times = [...new Set(results.map((r) => Number(r.entry_after ?? 0)))].sort((a, b) => a - b)
      const rrs = [...new Set(results.map((r) => Number(r.rr)))].sort((a, b) => a - b)
      const map = new Map<string, OptimizePoint>()
      for (const r of results) {
        const k = `${r.entry_after ?? 0}|${r.rr}`
        map.set(k, pickBetter(map.get(k), r, metric, meta.higherBetter))
      }
      const vals = [...map.values()].map((r) => Number(r[metric] ?? 0))
      return {
        mode: 'time_rr' as const,
        rows: times,
        cols: rrs,
        map,
        min: Math.min(...vals, 0),
        max: Math.max(...vals, 0),
        colFmt: 'num' as const,
        rowFmt: 'time' as const,
      }
    }

    const ths = [...new Set(results.map((r) => Number(r.threshold)))].sort((a, b) => a - b)
    const rrs = [...new Set(results.map((r) => Number(r.rr)))].sort((a, b) => a - b)
    const map = new Map<string, OptimizePoint>()
    for (const r of results) {
      const k = `${r.threshold}|${r.rr}`
      map.set(k, pickBetter(map.get(k), r, metric, meta.higherBetter))
    }
    const vals = [...map.values()].map((r) => Number(r[metric] ?? 0))
    return {
      mode: 'thr_rr' as const,
      rows: rrs,
      cols: ths,
      map,
      min: Math.min(...vals, 0),
      max: Math.max(...vals, 0),
      colFmt: 'num' as const,
      rowFmt: 'num' as const,
    }
  }, [results, metric, activeAxis, meta.higherBetter])

  if (grid.cols.length < 1 || grid.rows.length < 1) {
    return <p className="hint">Not enough grid points for a heatmap.</p>
  }

  const title =
    grid.mode === 'time_thr'
      ? 'PARAM SURFACE — Time × Thr'
      : grid.mode === 'time_rr'
        ? 'PARAM SURFACE — Time × RR'
        : 'PARAM HEATMAP — Thr × RR'
  const corner =
    grid.mode === 'time_thr' ? 'Time \\ Thr' : grid.mode === 'time_rr' ? 'Time \\ RR' : 'RR \\ Thr'

  const fmtAxis = (v: number, kind: 'num' | 'time') => (kind === 'time' ? minsLabel(v) : fmt2(v))

  return (
    <div className="opt-heatmap">
      <div className="opt-heatmap-head">
        <span className="strip-lab">{title}</span>
        {hasTimeAxis && (
          <label>
            Axes
            <select value={activeAxis} onChange={(e) => setAxis(e.target.value as AxisMode)}>
              <option value="thr_rr">Thr × RR</option>
              <option value="time_thr">Time × Thr</option>
              <option value="time_rr">Time × RR</option>
            </select>
          </label>
        )}
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
          {hasTimeAxis
            ? 'Time-opt detected — use Time × Thr / Time × RR for a useful surface. Click a cell to select.'
            : 'Click a cell to select. Hatched = overfit-risk heuristic (not true OOS).'}
          {sparseThrRr && !hasTimeAxis
            ? ' Grid is 1×1 on Thr×RR — widen Thr/RR ranges or enable Time opt.'
            : ''}
        </span>
      </div>
      <div className="opt-heatmap-scroll">
        <table className="opt-heatmap-table">
          <thead>
            <tr>
              <th>{corner}</th>
              {grid.cols.map((c) => (
                <th key={c}>{fmtAxis(c, grid.colFmt)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr key={row}>
                <th>{fmtAxis(row, grid.rowFmt)}</th>
                {grid.cols.map((col) => {
                  const point =
                    grid.mode === 'thr_rr'
                      ? grid.map.get(`${col}|${row}`)
                      : grid.map.get(`${row}|${col}`)
                  if (!point) {
                    return <td key={col} className="empty" />
                  }
                  const v = Number(point[metric] ?? 0)
                  const key = comboKey(point)
                  const risk = overfit.has(key)
                  const sel = selectedKey === key
                  return (
                    <td key={col}>
                      <button
                        type="button"
                        className={`opt-heat-cell${risk ? ' overfit' : ''}${sel ? ' selected' : ''}`}
                        style={{
                          background: cellColor(v, grid.min, grid.max, meta.higherBetter),
                        }}
                        title={`${
                          grid.mode === 'thr_rr'
                            ? `thr=${col} RR=${row}`
                            : grid.mode === 'time_thr'
                              ? `time=${minsLabel(row)} thr=${col}`
                              : `time=${minsLabel(row)} RR=${col}`
                        } ${meta.label}=${fmt2(v)}${risk ? ' · overfit risk' : ''}`}
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
