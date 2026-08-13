import { useMemo, useState } from 'react'
import type { BacktestResult } from '../api'
import { computeDashboard, sharpeWithRiskFree } from './computeDashboard'
import { SyncedDepthCharts } from './SyncedDepthCharts'
import { MetricRow, Sparkline, StreakBars, WinRateGauge } from './widgets'
import { FT } from './theme'
import { fmt2, fmtPct } from '../format'

type Props = {
  data: BacktestResult
  visible?: boolean
}

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

export function PerformanceOverviewDashboard({ data, visible = true }: Props) {
  const model = useMemo(() => computeDashboard(data), [data])
  const m = model.metrics
  const [rf, setRf] = useState(0)
  const [tradeSort, setTradeSort] = useState<'idx' | 'pnl' | 'duration'>('idx')

  const adjSharpe = useMemo(
    () => sharpeWithRiskFree(model.stepReturns, model.stepsPerYear, rf),
    [model.stepReturns, model.stepsPerYear, rf],
  )

  const recentSorted = useMemo(() => {
    const rows = [...model.recentTrades]
    if (tradeSort === 'pnl') rows.sort((a, b) => b.pnl - a.pnl)
    else if (tradeSort === 'duration') rows.sort((a, b) => b.durationHours - a.durationHours)
    else rows.sort((a, b) => b.idx - a.idx)
    return rows
  }, [model.recentTrades, tradeSort])

  const cagrDisplay = Number.isFinite(m.cagrPct) ? `${fmtPct(m.cagrPct)}%` : 'N/A'

  return (
    <div className="pod pod-v15" data-version="1.16.0">
      <header className="pod-header compact glass-panel">
        <h2 className="pod-title">PERFORMANCE OVERVIEW DASHBOARD</h2>
        <p className="pod-sub">
          {data.symbol} · {data.tf_minutes}m · thr {fmt2(data.threshold)} · RR {fmt2(data.rr)} ·{' '}
          {data.wait_and_trade
            ? 'Non-Directional'
            : data.pro_mode
              ? `Pro ±${Number((data.stats as { pro_vwap_sigma?: number })?.pro_vwap_sigma ?? data.params?.pro_vwap_sigma ?? 2)}σ`
              : 'Directional'}{' '}
          · v1.17.2
        </p>
      </header>

      {/* Row 1 — Chart 65% | Ratios + Trades 35% */}
      <div className="pod-row1">
        <section className="pod-charts glass-panel">
          <div className="pod-section-h">
            <h3>CUMULATIVE PnL & UNDERWATER DRAWDOWN</h3>
          </div>
          <SyncedDepthCharts model={model} visible={visible} />
        </section>

        <aside className="pod-side">
          <section className="glass-panel pod-metric-panel pod-side-ratios">
            <h3 className="pod-section-h">RISK &amp; RETURN RATIOS</h3>
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

          <section className="glass-panel pod-trades-preview pod-side-trades">
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
            <div className="pod-mini-table-wrap">
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
                        No trades
                      </td>
                    </tr>
                  )}
                  {recentSorted.map((t) => (
                    <tr key={t.idx}>
                      <td>{t.idx}</td>
                      <td>{fmtIsoShort(t.date)}</td>
                      <td>{t.type}</td>
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
        </aside>
      </div>

      {/* Row 2 — 4 equal performance cards */}
      <div className="pod-row2">
        <section className="glass-panel pod-stat-card">
          <h3 className="pod-section-h">TRADE CONSISTENCY</h3>
          <div className="pod-hero">
            <div className="pod-hero-lab">Win Rate</div>
            <div className="pod-hero-val">{fmtPct(m.winRate)}%</div>
            <WinRateGauge pct={m.winRate} />
          </div>
          <MetricRow icon="Σ" label="Profit Factor" value={fmt2(m.profitFactor)} />
          <MetricRow icon="$" label="Expectancy" value={fmt2(m.expectancy)} />
        </section>

        <section className="glass-panel pod-stat-card">
          <h3 className="pod-section-h">TRADE PnL</h3>
          <div className="pod-hero">
            <div className="pod-hero-lab">Total Net Profit</div>
            <div className={`pod-hero-val ${m.cumulativePnl >= 0 ? 'pos' : 'neg'}`}>
              {fmt2(m.cumulativePnl)}
            </div>
            <div className="pod-hero-sub">{fmtPct(m.totalReturnPct)}%</div>
            <Sparkline
              values={m.equityRawSpark}
              stroke={FT.neon}
              fill={FT.greenSoft}
              width={100}
              height={24}
            />
          </div>
          <MetricRow
            icon="#"
            label="Total Trades"
            value={`${m.totalTrades} (L ${m.longTrades} / S ${m.shortTrades})`}
          />
          <MetricRow
            icon="μ"
            label="Avg Trade PnL"
            value={`${fmt2(m.avgTradePnl)} · ${fmtPct(m.avgTradePnlPct)}%`}
          />
          <MetricRow icon="∶" label="Avg Win-to-Loss" value={fmt2(m.avgWinLossRatio)} />
        </section>

        <section className="glass-panel pod-stat-card">
          <h3 className="pod-section-h">TRADE DURATION</h3>
          <MetricRow icon="⏱" label="Avg Duration" value={fmtDur(m.avgTradeDurationHours)} />
          <MetricRow icon="▲" label="Avg Win Duration" value={fmtDur(m.avgWinDurationHours)} />
          <MetricRow icon="▼" label="Avg Loss Duration" value={fmtDur(m.avgLossDurationHours)} />
        </section>

        <section className="glass-panel pod-stat-card">
          <h3 className="pod-section-h">EXTREME STATS</h3>
          <StreakBars wins={m.maxConsecWins} losses={m.maxConsecLosses} />
          <MetricRow icon="★" label="Largest Win" value={fmt2(m.largestWin)} />
          <MetricRow icon="☠" label="Largest Loss" value={fmt2(m.largestLoss)} />
        </section>
      </div>
    </div>
  )
}
