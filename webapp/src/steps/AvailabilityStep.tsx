import type { DataAvailability } from '../api'

type Props = {
  availability: DataAvailability | null
  busy: boolean
  onRecheck: () => void
  onContinue: () => void
}

export function AvailabilityStep({ availability, busy, onRecheck, onContinue }: Props) {
  const ready = Boolean(availability?.ready)

  return (
    <div className="panel step-panel">
      <h2>Step 2 — Data Availability</h2>
      <p className="hint">Validate that ticks, bars, and date coverage are ready for backtesting.</p>

      <div className={`avail-hero ${ready ? 'pass' : availability ? 'fail' : 'idle'}`}>
        <div className="avail-mark">{ready ? '✓' : availability ? '!' : '…'}</div>
        <div>
          <div className="avail-title">
            {ready
              ? 'Data available — green pass'
              : availability
                ? 'Data incomplete'
                : 'Waiting for load / check'}
          </div>
          {availability && (
            <div className="avail-sub">
              {availability.symbol} · {availability.tf}m · {availability.start} → {availability.end}
              {availability.bars_in_range != null && ` · ${availability.bars_in_range} bars`}
            </div>
          )}
        </div>
      </div>

      {availability && (
        <ul className="check-list">
          {availability.checks.map((c) => (
            <li key={c.id} className={c.ok ? 'ok' : 'bad'}>
              <span className="tick">{c.ok ? '✓' : '✗'}</span>
              <div>
                <strong>{c.label}</strong>
                <div className="detail">{c.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="form-row">
        <button className="ghost" disabled={busy} onClick={onRecheck}>
          Re-check
        </button>
        <button disabled={!ready || busy} onClick={onContinue}>
          Continue to Strategy Backtest
        </button>
      </div>
    </div>
  )
}
