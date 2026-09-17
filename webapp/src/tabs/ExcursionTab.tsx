import { useMemo, useState } from 'react'
import type { BacktestResult } from '../api'
import { computeDashboard, type SideBucketStats } from '../dashboard/computeDashboard'
import { ExcursionScatter } from '../dashboard/ExcursionScatter'
import { TemporalExcursionScatter } from '../dashboard/TemporalExcursionScatter'
import { fmt2, fmtPct } from '../format'

type Props = {
  data: BacktestResult | null
  visible?: boolean
}

type SideFilter = 'all' | 'long' | 'short'

function SideCell({
  value,
  tone,
}: {
  value: string
  tone?: 'pos' | 'neg' | 'long' | 'short' | ''
}) {
  const cls =
    tone === 'pos' || tone === 'long' ? 'pos' : tone === 'neg' || tone === 'short' ? 'neg' : ''
  return <td className={cls || undefined}>{value}</td>
}

function sideTone(n: number): 'pos' | 'neg' | '' {
  if (!Number.isFinite(n) || n === 0) return ''
  return n > 0 ? 'pos' : 'neg'
}

export function ExcursionTab({ data, visible = true }: Props) {
  const [sideFilter, setSideFilter] = useState<SideFilter>('all')
  const [pane, setPane] = useState<'timing' | 'size'>('size')
  const model = useMemo(() => (data ? computeDashboard(data) : null), [data])

  if (!data || !model) {
    if (!visible) return null
    return <p className="hint">No excursion data yet — run a backtest first.</p>
  }

  const { all, long, short } = model.bySide
  const scopedTrades =
    sideFilter === 'long'
      ? data.trades.filter((t) => String(t.side).toLowerCase().includes('long'))
      : sideFilter === 'short'
        ? data.trades.filter((t) => String(t.side).toLowerCase().includes('short'))
        : data.trades

  const row = (
    label: string,
    title: string,
    cell: (b: SideBucketStats) => string,
    tone?: (b: SideBucketStats) => 'pos' | 'neg' | 'long' | 'short' | '',
  ) => (
    <tr>
      <td title={title}>{label}</td>
      <SideCell value={all.trades ? cell(all) : '—'} tone={tone?.(all)} />
      <SideCell value={long.trades ? cell(long) : '—'} tone={tone?.(long) || 'long'} />
      <SideCell value={short.trades ? cell(short) : '—'} tone={tone?.(short) || 'short'} />
    </tr>
  )

  return (
    <div
      className="panel excursion-tab-panel pod-shell"
      style={{ display: visible ? 'flex' : 'none', flexDirection: 'column' }}
    >
      <div className="pod pod-exc">
        <header className="pod-header compact glass-panel pod-perf-header">
          <div className="pod-perf-titleblock">
            <h2 className="pod-title">EXCURSION</h2>
            <p className="pod-sub">
              {data.symbol} · {data.tf_minutes}m · size (MFE/MAE vs PnL) and timing (tMFE / tMAE)
            </p>
          </div>
          <div className="pod-side-toggle" role="group" aria-label="Excursion chart">
            {(
              [
                ['timing', 'Timing'],
                ['size', 'MFE / MAE'],
              ] as const
            ).map(([id, lab]) => (
              <button
                key={id}
                type="button"
                className={pane === id ? 'active' : ''}
                onClick={() => setPane(id)}
              >
                {lab}
              </button>
            ))}
          </div>
          <div className="pod-side-toggle" role="group" aria-label="Trade side filter">
            {(
              [
                ['all', 'ALL'],
                ['long', 'LONG'],
                ['short', 'SHORT'],
              ] as const
            ).map(([id, lab]) => (
              <button
                key={id}
                type="button"
                className={sideFilter === id ? 'active' : ''}
                onClick={() => setSideFilter(id)}
              >
                {lab}
              </button>
            ))}
          </div>
        </header>

        {pane === 'timing' && (
        <section className="glass-panel pod-stat-card pod-exc-metrics">
          <h3 className="pod-section-h">
            TIMING METRICS{sideFilter !== 'all' ? ` (${sideFilter.toUpperCase()})` : ''}
          </h3>
          <table className={`pod-side-table filter-${sideFilter}`}>
            <thead>
              <tr>
                <th>Metric</th>
                <th>ALL</th>
                <th className="long">LONG</th>
                <th className="short">SHORT</th>
              </tr>
            </thead>
            <tbody>
              {row('Avg tMFE', 'Average minutes to first MFE', (b) =>
                b.timedExcursions ? `${fmt2(b.avgTmfe)}m` : '—',
              )}
              {row('Avg tMAE', 'Average minutes to first MAE', (b) => `${fmt2(b.avgTmae)}m`)}
              {row(
                'Avg ΔT',
                'Avg (tMFE − tMAE). Positive = MAE first.',
                (b) => (b.timedExcursions ? `${b.avgDt >= 0 ? '+' : ''}${fmt2(b.avgDt)}m` : '—'),
                (b) => sideTone(b.avgDt),
              )}
              {row('MAE-first %', 'MAE printed first (early drawdown, then run)', (b) =>
                b.timedExcursions ? `${fmtPct(b.pctMaeFirst)}%` : '—',
              )}
              {row('MFE-first %', 'MFE printed first (green, then giveback)', (b) =>
                b.timedExcursions ? `${fmtPct(b.pctMfeFirst)}%` : '—',
              )}
              {row('Premature %', 'tMAE ≤ 2 bars — entry went adverse immediately', (b) =>
                `${fmtPct(b.pctPremature)}%`,
              )}
              {row('Momentum %', 'tMFE / hold ≥ 70% — favorable extreme near the exit', (b) =>
                `${fmtPct(b.pctMomentum)}%`,
              )}
            </tbody>
          </table>
        </section>
        )}

        {pane === 'timing' && (
        <section className="glass-panel pod-stat-card pod-card-exc-timing">
          <h3 className="pod-section-h">
            TIME TO MFE vs TIME TO MAE
            {sideFilter !== 'all' ? ` (${sideFilter.toUpperCase()})` : ''}
          </h3>
          <p className="pod-card-note">
            Each dot is a trade: X = time to first MAE, Y = time to first MFE. The 45° line is ΔT =
            0. Above the line the trade drew down first; below it the trade was green first.
          </p>
          <TemporalExcursionScatter
            trades={scopedTrades}
            tfMinutes={Number(data.tf_minutes || 15)}
          />
        </section>
        )}

        {pane === 'size' && (
        <section className="glass-panel pod-stat-card pod-exc-size">
          <h3 className="pod-section-h">
            MFE / MAE vs PnL
            {sideFilter !== 'all' ? ` (${sideFilter.toUpperCase()})` : ''}
          </h3>
          <p className="pod-card-note">
            Magnitude excursion: how far price ran in your favor / against you versus realized PnL.
          </p>
          <ExcursionScatter trades={scopedTrades} symbol={data.symbol} />
        </section>
        )}
      </div>
    </div>
  )
}
