import { useMemo, useState } from 'react'
import type { BacktestResult } from '../api'
import {
  computeDashboard,
  sharpeWithRiskFree,
  type SideBucketStats,
} from './computeDashboard'
import { MetricRow, StreakBars, WinRateGauge } from './widgets'
import { FT } from './theme'
import { fmt2, fmtPct } from '../format'

type Props = {
  data: BacktestResult
  visible?: boolean
}

type SideFilter = 'all' | 'long' | 'short'

function fmtDur(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '—'
  if (hours < 24) return `${fmt2(hours)}h`
  return `${fmt2(hours / 24)}d`
}

function fmtIsoShort(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

function safeNum(n: number, digits = true): string {
  if (!Number.isFinite(n)) return '—'
  return digits ? fmt2(n) : String(n)
}

function SideCell({
  value,
  tone,
}: {
  value: string
  tone?: 'pos' | 'neg' | 'long' | 'short' | ''
}) {
  const cls =
    tone === 'pos' || tone === 'long'
      ? 'pos'
      : tone === 'neg' || tone === 'short'
        ? 'neg'
        : ''
  return <td className={cls}>{value}</td>
}

function sideTone(n: number): 'pos' | 'neg' | '' {
  if (!Number.isFinite(n) || n === 0) return ''
  return n > 0 ? 'pos' : 'neg'
}

export function PerformanceOverviewDashboard({ data, visible = true }: Props) {
  const model = useMemo(() => computeDashboard(data), [data])
  const m = model.metrics
  const { all, long, short } = model.bySide
  const [rf, setRf] = useState(0)
  const [sideFilter, setSideFilter] = useState<SideFilter>('all')
  const [tradeSort, setTradeSort] = useState<'idx' | 'pnl' | 'duration'>('idx')

  const adjSharpe = useMemo(
    () => sharpeWithRiskFree(model.stepReturns, model.stepsPerYear, rf),
    [model.stepReturns, model.stepsPerYear, rf],
  )

  const filteredBucket: SideBucketStats =
    sideFilter === 'long' ? long : sideFilter === 'short' ? short : all

  const recentSorted = useMemo(() => {
    let rows = [...model.allTradeRows]
    if (sideFilter === 'long') {
      rows = rows.filter((t) => t.type.toLowerCase().includes('long'))
    } else if (sideFilter === 'short') {
      rows = rows.filter((t) => t.type.toLowerCase().includes('short'))
    }
    if (tradeSort === 'pnl') rows.sort((a, b) => b.pnl - a.pnl)
    else if (tradeSort === 'duration') rows.sort((a, b) => b.durationHours - a.durationHours)
    else rows.sort((a, b) => b.idx - a.idx)
    return rows.slice(0, 40)
  }, [model.allTradeRows, tradeSort, sideFilter])

  const cagrDisplay = Number.isFinite(m.cagrPct) ? `${fmtPct(m.cagrPct)}%` : 'N/A'
  const mode = data.wait_and_trade
    ? 'Non-Directional'
    : data.pro_mode
      ? `Pro ±${Number((data.stats as { pro_vwap_sigma?: number })?.pro_vwap_sigma ?? data.params?.pro_vwap_sigma ?? 2)}σ`
      : 'Directional'

  if (!visible) {
    return <div className="pod pod-perf" style={{ display: 'none' }} />
  }

  return (
    <div className="pod pod-perf">
      <header className="pod-header compact glass-panel pod-perf-header">
        <div className="pod-perf-titleblock">
          <h2 className="pod-title">PERFORMANCE</h2>
          <p className="pod-sub">
            {data.symbol} · {data.tf_minutes}m · thr {fmt2(data.threshold)} · RR {fmt2(data.rr)} ·{' '}
            {mode}
          </p>
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

      <div className="pod-perf-grid">
        <section className="glass-panel pod-stat-card pod-card-ratios">
          <h3 className="pod-section-h">RISK &amp; RETURN RATIOS</h3>
          <p className="pod-card-note">Portfolio equity (not side-filtered)</p>
          <label className="pod-rf">
            Risk-free %
            <input
              type="number"
              step="0.25"
              value={rf}
              onChange={(e) => setRf(Number(e.target.value) || 0)}
              title="Annual risk-free rate for Sharpe"
            />
          </label>
          <MetricRow icon="↗" label="CAGR %" value={cagrDisplay} spark={m.equitySpark} />
          <MetricRow
            icon="σ"
            label={`Sharpe (rf ${fmt2(rf)}%)`}
            value={fmt2(adjSharpe)}
            spark={m.equitySpark}
            sparkStroke={FT.azure}
          />
          <MetricRow
            icon="▼"
            label="Max Drawdown %"
            value={`${fmtPct(m.maxDrawdownPct)}%`}
            spark={m.ddRawSpark}
            sparkStroke={FT.crimson}
          />
          <MetricRow icon="↓" label="Max DD $" value={fmt2(m.maxDrawdownAbs)} />
          <MetricRow
            icon="⏱"
            label="DD Duration"
            value={`${fmt2(m.maxDdDurationDays)}d · ${m.maxDdDurationBars} bars`}
          />
          <MetricRow icon="◇" label="Sortino" value={fmt2(m.sortino)} />
          <MetricRow icon="▣" label="Calmar" value={fmt2(m.calmar)} />
          <MetricRow icon="↺" label="Recovery" value={fmt2(m.recoveryFactor)} />
          <MetricRow icon="∿" label="Vol (ann.)" value={`${fmtPct(m.volatilityAnnPct)}%`} />
        </section>

        <section className="glass-panel pod-stat-card">
          <h3 className="pod-section-h">TRADE CONSISTENCY</h3>
          <div className="pod-hero">
            <div className="pod-hero-lab">
              Win Rate {sideFilter !== 'all' ? `(${sideFilter})` : ''}
            </div>
            <div className="pod-hero-val">{fmtPct(filteredBucket.winRate)}%</div>
            <WinRateGauge pct={filteredBucket.winRate} />
          </div>
          <table className="pod-side-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>ALL</th>
                <th className="long">LONG</th>
                <th className="short">SHORT</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Win Rate %</td>
                <SideCell value={`${fmtPct(all.winRate)}%`} />
                <SideCell
                  value={long.trades ? `${fmtPct(long.winRate)}%` : '—'}
                  tone="long"
                />
                <SideCell
                  value={short.trades ? `${fmtPct(short.winRate)}%` : '—'}
                  tone="short"
                />
              </tr>
              <tr>
                <td>Expectancy</td>
                <SideCell value={safeNum(all.expectancy)} tone={sideTone(all.expectancy)} />
                <SideCell
                  value={long.trades ? safeNum(long.expectancy) : '—'}
                  tone={sideTone(long.expectancy)}
                />
                <SideCell
                  value={short.trades ? safeNum(short.expectancy) : '—'}
                  tone={sideTone(short.expectancy)}
                />
              </tr>
            </tbody>
          </table>
        </section>

        <section className="glass-panel pod-stat-card pod-card-pnl">
          <h3 className="pod-section-h">TRADE PnL</h3>
          <div className="pod-hero">
            <div className="pod-hero-lab">Total Net Profit ({sideFilter.toUpperCase()})</div>
            <div
              className={`pod-hero-val ${
                (sideFilter === 'all'
                  ? Number(data.stats?.net_pnl ?? filteredBucket.netPnl)
                  : filteredBucket.netPnl) >= 0
                  ? 'pos'
                  : 'neg'
              }`}
            >
              {safeNum(
                sideFilter === 'all'
                  ? Number(data.stats?.net_pnl ?? filteredBucket.netPnl)
                  : filteredBucket.netPnl,
              )}
            </div>
          </div>
          <table className="pod-side-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>ALL</th>
                <th className="long">LONG</th>
                <th className="short">SHORT</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Net Profit</td>
                <SideCell
                  value={safeNum(Number(data.stats?.net_pnl ?? all.netPnl))}
                  tone={sideTone(Number(data.stats?.net_pnl ?? all.netPnl))}
                />
                <SideCell
                  value={long.trades ? safeNum(long.netPnl) : '—'}
                  tone={sideTone(long.netPnl)}
                />
                <SideCell
                  value={short.trades ? safeNum(short.netPnl) : '—'}
                  tone={sideTone(short.netPnl)}
                />
              </tr>
              <tr>
                <td>Total Trades</td>
                <SideCell value={String(all.trades)} />
                <SideCell value={String(long.trades)} tone="long" />
                <SideCell value={String(short.trades)} tone="short" />
              </tr>
              <tr>
                <td>Avg PnL $</td>
                <SideCell value={safeNum(all.avgPnl)} tone={sideTone(all.avgPnl)} />
                <SideCell
                  value={long.trades ? safeNum(long.avgPnl) : '—'}
                  tone={sideTone(long.avgPnl)}
                />
                <SideCell
                  value={short.trades ? safeNum(short.avgPnl) : '—'}
                  tone={sideTone(short.avgPnl)}
                />
              </tr>
              <tr>
                <td>Avg PnL %</td>
                <SideCell
                  value={all.trades ? `${fmtPct(all.avgPnlPct)}%` : '—'}
                  tone={sideTone(all.avgPnlPct)}
                />
                <SideCell
                  value={long.trades ? `${fmtPct(long.avgPnlPct)}%` : '—'}
                  tone={sideTone(long.avgPnlPct)}
                />
                <SideCell
                  value={short.trades ? `${fmtPct(short.avgPnlPct)}%` : '—'}
                  tone={sideTone(short.avgPnlPct)}
                />
              </tr>
              <tr>
                <td>Profit Factor</td>
                <SideCell value={safeNum(all.profitFactor)} />
                <SideCell value={long.trades ? safeNum(long.profitFactor) : '—'} tone="long" />
                <SideCell value={short.trades ? safeNum(short.profitFactor) : '—'} tone="short" />
              </tr>
              <tr>
                <td>Avg MFE</td>
                <SideCell value={safeNum(all.avgMfe)} />
                <SideCell value={long.trades ? safeNum(long.avgMfe) : '—'} tone="long" />
                <SideCell value={short.trades ? safeNum(short.avgMfe) : '—'} tone="short" />
              </tr>
              <tr>
                <td>Avg MAE</td>
                <SideCell value={safeNum(all.avgMae)} />
                <SideCell value={long.trades ? safeNum(long.avgMae) : '—'} tone="long" />
                <SideCell value={short.trades ? safeNum(short.avgMae) : '—'} tone="short" />
              </tr>
              <tr>
                <td>E-ratio</td>
                <SideCell value={safeNum(all.eRatio)} />
                <SideCell value={long.trades ? safeNum(long.eRatio) : '—'} tone="long" />
                <SideCell value={short.trades ? safeNum(short.eRatio) : '—'} tone="short" />
              </tr>
              <tr>
                <td>SQN</td>
                <SideCell value={safeNum(all.sqn)} />
                <SideCell value={long.trades ? safeNum(long.sqn) : '—'} tone="long" />
                <SideCell value={short.trades ? safeNum(short.sqn) : '—'} tone="short" />
              </tr>
            </tbody>
          </table>
        </section>

        <section className="glass-panel pod-stat-card">
          <h3 className="pod-section-h">CONSECUTIVE WINS / LOSSES</h3>
          <table className="pod-side-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>ALL</th>
                <th className="long">LONG</th>
                <th className="short">SHORT</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Max Consec Wins</td>
                <SideCell value={String(all.maxConsecWins)} />
                <SideCell
                  value={long.trades ? String(long.maxConsecWins) : '—'}
                  tone="long"
                />
                <SideCell
                  value={short.trades ? String(short.maxConsecWins) : '—'}
                  tone="short"
                />
              </tr>
              <tr>
                <td>Max Consec Losses</td>
                <SideCell value={String(all.maxConsecLosses)} />
                <SideCell
                  value={long.trades ? String(long.maxConsecLosses) : '—'}
                  tone="long"
                />
                <SideCell
                  value={short.trades ? String(short.maxConsecLosses) : '—'}
                  tone="short"
                />
              </tr>
            </tbody>
          </table>
          <StreakBars wins={filteredBucket.maxConsecWins} losses={filteredBucket.maxConsecLosses} />
          <p className="pod-card-note">
            Streaks = longest run of wins/losses in sequence — not Win× / Loss× trade counts
            (see Extreme Stats). ALL short: {short.winCount}W + {short.lossCount}L ={' '}
            {short.trades} trades.
          </p>
        </section>

        <section className="glass-panel pod-stat-card">
          <h3 className="pod-section-h">EXTREME STATS</h3>
          <MetricRow icon="✓" label="Long Win ×" value={String(long.winCount)} />
          <MetricRow icon="✗" label="Long Loss ×" value={String(long.lossCount)} />
          <MetricRow icon="✓" label="Short Win ×" value={String(short.winCount)} />
          <MetricRow icon="✗" label="Short Loss ×" value={String(short.lossCount)} />
          <MetricRow
            icon="★"
            label="Largest Long Win"
            value={long.trades ? safeNum(long.largestWin) : '—'}
          />
          <MetricRow
            icon="☠"
            label="Largest Long Loss"
            value={long.trades ? safeNum(long.largestLoss) : '—'}
          />
          <MetricRow
            icon="★"
            label="Largest Short Win"
            value={short.trades ? safeNum(short.largestWin) : '—'}
          />
          <MetricRow
            icon="☠"
            label="Largest Short Loss"
            value={short.trades ? safeNum(short.largestLoss) : '—'}
          />
        </section>

        <section className="glass-panel pod-stat-card pod-card-trades">
          <div className="pod-section-h row">
            <h3>TRADE LIST SUMMARY</h3>
            <select
              value={tradeSort}
              onChange={(e) => setTradeSort(e.target.value as typeof tradeSort)}
              aria-label="Sort trades"
            >
              <option value="idx">Recent</option>
              <option value="pnl">PnL</option>
              <option value="duration">Duration</option>
            </select>
          </div>
          <div className="pod-mini-table-wrap pod-trades-scroll">
            <table className="pod-mini-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Date</th>
                  <th>Type</th>
                  <th>PnL (%)</th>
                  <th>Dur</th>
                </tr>
              </thead>
              <tbody>
                {recentSorted.length === 0 && (
                  <tr>
                    <td colSpan={5} className="pod-muted">
                      No trades{sideFilter !== 'all' ? ` (${sideFilter})` : ''}
                    </td>
                  </tr>
                )}
                {recentSorted.map((t) => (
                  <tr key={t.idx}>
                    <td>{t.idx}</td>
                    <td>{fmtIsoShort(t.date)}</td>
                    <td
                      className={
                        t.type.toLowerCase().includes('long')
                          ? 'pos'
                          : t.type.toLowerCase().includes('short')
                            ? 'neg'
                            : ''
                      }
                    >
                      {t.type}
                    </td>
                    <td className={t.pnl >= 0 ? 'pos' : 'neg'}>
                      {fmt2(t.pnl)} ({fmtPct(t.pnlPct)}%)
                    </td>
                    <td>{fmtDur(t.durationHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}
