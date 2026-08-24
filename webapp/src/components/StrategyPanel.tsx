import type { Dispatch, SetStateAction } from 'react'
import type { StrategyParams } from '../api'

type Props = {
  params: StrategyParams
  onChange: Dispatch<SetStateAction<StrategyParams>>
  busy: boolean
  /** Hide exchange/symbol/dates/tf when controlled by Data Loader step */
  hideDataFields?: boolean
}

function minsLabel(m: number): string {
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')} IST`
}

export function StrategyPanel({ params, onChange, busy, hideDataFields }: Props) {
  const set = <K extends keyof StrategyParams>(key: K, value: StrategyParams[K]) =>
    onChange((prev) => ({ ...prev, [key]: value }))

  const setMany = (patch: Partial<StrategyParams>) =>
    onChange((prev) => ({ ...prev, ...patch }))

  return (
    <aside className="strategy-panel">
      <h2>Strategy parameters</h2>
      <p className="hint">
        {hideDataFields
          ? 'Change timeframe or params, then click Run.'
          : 'Click Run backtest to start. Edits apply on the next Run.'}
      </p>

      {!hideDataFields && (
        <>
          <label>
            Symbol
            <input
              value={params.symbol}
              onChange={(e) => set('symbol', e.target.value.toUpperCase())}
              disabled={busy}
            />
          </label>
          <label>
            Timeframe
            <select
              value={params.tf}
              disabled={busy}
              onChange={(e) => set('tf', Number(e.target.value))}
            >
              {[1, 3, 5, 15, 30, 60].map((tf) => (
                <option key={tf} value={tf}>
                  {tf}m
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      {hideDataFields && (
        <>
          <div className="data-chip">
            {params.exchange} · {params.symbol}
            <br />
            {params.start} → {params.end}
          </div>
          <label>
            Timeframe
            <select
              value={params.tf}
              disabled={busy}
              onChange={(e) => set('tf', Number(e.target.value))}
            >
              {[1, 3, 5, 15, 30, 60].map((tf) => (
                <option key={tf} value={tf}>
                  {tf}m
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      <label>
        Threshold Δ%
        <input
          type="number"
          step="0.01"
          value={params.threshold}
          onChange={(e) => set('threshold', Number(e.target.value))}
        />
      </label>

      <label>
        RR
        <input
          type="number"
          step="0.01"
          value={params.rr}
          onChange={(e) => set('rr', Number(e.target.value))}
        />
      </label>

      <label>
        Volume
        <input
          type="number"
          step="0.01"
          value={params.volume}
          onChange={(e) => set('volume', Number(e.target.value))}
        />
      </label>

      <label title="Directional = baseline. Non-Directional = ORB+reverse. Pro = VWAP tags + reverse.">
        Strategy
        <select
          value={
            params.pro_mode
              ? 'pro'
              : params.wait_and_trade
                ? 'non_directional'
                : 'directional'
          }
          onChange={(e) => {
            const v = e.target.value
            const nd = v === 'non_directional'
            const pro = v === 'pro'
            setMany({
              wait_and_trade: nd,
              pro_mode: pro,
              re_entry: 0,
              stop_to_be: 0,
              ...(nd ? { break_even: 0 } : {}),
            })
          }}
        >
          <option value="directional">Directional</option>
          <option value="non_directional">Non-Directional</option>
          <option value="pro">Pro</option>
        </select>
      </label>

      {params.pro_mode && (
        <label title="Pro: whole candle above VWAP+Nσ (low > +Nσ) or below VWAP−Nσ (high < −Nσ). Then Lo/Sh/Se/Co.">
          VWAP σ
          <select
            value={params.pro_vwap_sigma}
            onChange={(e) => set('pro_vwap_sigma', Number(e.target.value))}
          >
            <option value={1}>±1σ</option>
            <option value={2}>±2σ</option>
            <option value={3}>±3σ</option>
          </select>
        </label>
      )}

      {!params.wait_and_trade && (
        <>
          <label title="Arm at 1× range; lock stop at BE% × range once.">
            BreakEven
            <input
              type="checkbox"
              checked={params.break_even === 1}
              onChange={(e) => set('break_even', e.target.checked ? 1 : 0)}
            />
          </label>
          {params.break_even === 1 && (
            <label title="BE lock as % of signal range from entry (default 50)">
              BreakEven %
              <input
                type="number"
                min={1}
                max={100}
                step={5}
                value={params.break_even_pct}
                onChange={(e) => set('break_even_pct', Number(e.target.value))}
                onBlur={() =>
                  set(
                    'break_even_pct',
                    Math.min(100, Math.max(1, Number(params.break_even_pct) || 50)),
                  )
                }
              />
            </label>
          )}
        </>
      )}

      <label>
        Sides
        <select
          value={params.trade_mode}
          onChange={(e) => set('trade_mode', Number(e.target.value))}
        >
          <option value={2}>Both</option>
          <option value={0}>Long only</option>
          <option value={1}>Short only</option>
        </select>
      </label>

      <label>
        Entry after ({minsLabel(params.entry_after)})
        <input
          type="number"
          value={params.entry_after}
          onChange={(e) => set('entry_after', Number(e.target.value))}
        />
      </label>

      <label>
        Entry before ({minsLabel(params.entry_before)})
        <input
          type="number"
          value={params.entry_before}
          onChange={(e) => set('entry_before', Number(e.target.value))}
        />
      </label>

      <label>
        Flat / exit ({minsLabel(params.exit_time)})
        <input
          type="number"
          value={params.exit_time}
          onChange={(e) => set('exit_time', Number(e.target.value))}
        />
      </label>
    </aside>
  )
}
