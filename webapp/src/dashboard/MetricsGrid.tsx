import type { DashboardMetrics } from './computeDashboard'
import { MetricCard } from './MetricCard'
import { fmt2 } from '../format'

type Props = {
  metrics: DashboardMetrics
}

function toneNum(v: number, invert = false): 'pos' | 'neg' | 'neutral' {
  if (Math.abs(v) < 1e-12) return 'neutral'
  const pos = invert ? v < 0 : v > 0
  return pos ? 'pos' : 'neg'
}

export function MetricsGrid({ metrics: m }: Props) {
  return (
    <div className="metrics-dashboard">
      <section>
        <h3 className="metrics-section-title">Returns</h3>
        <div className="metrics-cards">
          <MetricCard
            label="Total Return"
            value={`${fmt2(m.totalReturnPct)}%`}
            tone={toneNum(m.totalReturnPct)}
            spark={m.equitySpark}
            delta={`vs B&H ${fmt2(m.excessReturnPct)}%`}
            deltaTone={toneNum(m.excessReturnPct)}
          />
          <MetricCard
            label="CAGR"
            value={`${fmt2(m.cagrPct)}%`}
            tone={toneNum(m.cagrPct)}
            spark={m.equitySpark}
          />
          <MetricCard
            label="Cumulative PnL"
            value={fmt2(m.cumulativePnl)}
            tone={toneNum(m.cumulativePnl)}
            spark={m.pnlSpark}
            delta={`B&H ${fmt2(m.bhTotalReturnPct)}%`}
            deltaTone="neutral"
          />
        </div>
      </section>

      <section>
        <h3 className="metrics-section-title">Risk-adjusted</h3>
        <div className="metrics-cards">
          <MetricCard label="Sharpe" value={fmt2(m.sharpe)} tone={toneNum(m.sharpe)} />
          <MetricCard label="Sortino" value={fmt2(m.sortino)} tone={toneNum(m.sortino)} />
          <MetricCard label="Calmar" value={fmt2(m.calmar)} tone={toneNum(m.calmar)} />
          <MetricCard
            label="Max Drawdown"
            value={`${fmt2(m.maxDrawdownPct)}%`}
            hint={`Absolute DD ${fmt2(m.maxDrawdownAbs)}`}
            tone="neg"
            spark={m.ddSpark}
          />
          <MetricCard
            label="DD Duration"
            value={`${fmt2(m.maxDdDurationHours)}h`}
            hint="Peak → trough → recovery (hours)"
            tone="warn"
          />
          <MetricCard
            label="Volatility (ann.)"
            value={`${fmt2(m.volatilityAnnPct)}%`}
            tone="neutral"
          />
        </div>
      </section>

      <section>
        <h3 className="metrics-section-title">Trade stats</h3>
        <div className="metrics-cards">
          <MetricCard label="Win Rate" value={`${fmt2(m.winRate)}%`} tone={m.winRate >= 50 ? 'pos' : 'neg'} />
          <MetricCard label="Profit Factor" value={fmt2(m.profitFactor)} tone={toneNum(m.profitFactor - 1)} />
          <MetricCard label="Expectancy" value={fmt2(m.expectancy)} tone={toneNum(m.expectancy)} />
          <MetricCard label="Avg Win" value={fmt2(m.avgWin)} tone="pos" />
          <MetricCard label="Avg Loss" value={fmt2(m.avgLoss)} tone="neg" />
          <MetricCard label="Win/Loss Ratio" value={fmt2(m.avgWinLossRatio)} tone={toneNum(m.avgWinLossRatio - 1)} />
          <MetricCard label="Total Trades" value={String(m.totalTrades)} />
          <MetricCard label="Avg Duration" value={`${fmt2(m.avgTradeDurationHours)}h`} />
          <MetricCard label="Largest Win" value={fmt2(m.largestWin)} tone="pos" />
          <MetricCard label="Largest Loss" value={fmt2(m.largestLoss)} tone="neg" />
          <MetricCard label="Consec Wins" value={String(m.maxConsecWins)} tone="pos" />
          <MetricCard label="Consec Losses" value={String(m.maxConsecLosses)} tone="neg" />
        </div>
      </section>

      <section>
        <h3 className="metrics-section-title">Exposure</h3>
        <div className="metrics-cards">
          <MetricCard label="% Time in Market" value={`${fmt2(m.timeInMarketPct)}%`} />
          <MetricCard label="Avg Position Size" value={fmt2(m.avgPositionSize)} hint="Strategy volume" />
          <MetricCard label="Turnover" value={fmt2(m.turnover)} hint="Entry+exit legs proxy" />
        </div>
      </section>
    </div>
  )
}
