import type { Dispatch, SetStateAction } from 'react'
import type { BacktestResult, StrategyParams } from '../api'
import { ChartsTab } from '../tabs/ChartsTab'
import { EquityTab } from '../tabs/EquityTab'
import { PerformanceTab } from '../tabs/PerformanceTab'
import { TradesTab } from '../tabs/TradesTab'
import { MetricsPanel } from '../components/MetricsPanel'
import { fmt2 } from '../format'

type Props = {
  params: StrategyParams
  onParams: Dispatch<SetStateAction<StrategyParams>>
  data: BacktestResult | null
  busy: boolean
  sessionStarted: boolean
  onRun: () => void
  onGoOptimize: () => void
  view: 'charts' | 'trades' | 'equity' | 'performance'
  onView: (v: 'charts' | 'trades' | 'equity' | 'performance') => void
}

function minsToTime(m: number): string {
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function timeToMins(v: string): number {
  const [hh, mm] = v.split(':').map(Number)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0
  return hh * 60 + mm
}

/** Slip/Fee: 0 = off, else clamp to [0.005, 1]. */
function clampCostPct(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(1, Math.max(0.005, n))
}

export function BacktestStep({
  params,
  onParams,
  data,
  busy,
  sessionStarted,
  onRun,
  onGoOptimize,
  view,
  onView,
}: Props) {
  const set = <K extends keyof StrategyParams>(key: K, value: StrategyParams[K]) =>
    onParams((prev) => ({ ...prev, [key]: value }))

  const setMany = (patch: Partial<StrategyParams>) =>
    onParams((prev) => ({ ...prev, ...patch }))

  const net = data ? Number(data.stats.net_pnl) : 0
  const win = data ? Number(data.stats.win_rate) : 0
  const trades = data ? Number(data.stats.trades) : 0

  return (
    <div className="bt-compact">
      <div className="control-strip">
        <div className="strip-seg">
          <span className="strip-lab">DATA</span>
          <span>{params.exchange}</span>
          <b>{params.symbol}</b>
          <span>
            {params.start} → {params.end}
          </span>
          <label>
            TF
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
        </div>

        <span className="strip-div" aria-hidden />

        <div className="strip-seg">
          <span className="strip-lab">STRATEGY</span>
          <label>
            Thr%
            <input
              className="num-plain"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={params.threshold}
              onChange={(e) => set('threshold', Number(e.target.value))}
            />
          </label>
          <label>
            RR
            <input
              className="num-plain"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={params.rr}
              onChange={(e) => set('rr', Number(e.target.value))}
            />
          </label>
          <label>
            Vol
            <input
              className="num-plain"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={params.volume}
              onChange={(e) => set('volume', Number(e.target.value))}
            />
          </label>
          <label>
            Slip%
            <input
              className="num-plain cost"
              type="number"
              inputMode="decimal"
              step="0.005"
              min={0}
              max={1}
              value={params.slippage_pct}
              onChange={(e) => set('slippage_pct', Number(e.target.value))}
              onBlur={() => set('slippage_pct', clampCostPct(params.slippage_pct))}
              title="Slippage % of price (0 = off, else 0.005–1)"
            />
          </label>
          <label>
            Fee%
            <input
              className="num-plain cost"
              type="number"
              inputMode="decimal"
              step="0.005"
              min={0}
              max={1}
              value={params.fee_pct}
              onChange={(e) => set('fee_pct', Number(e.target.value))}
              onBlur={() => set('fee_pct', clampCostPct(params.fee_pct))}
              title="Fee % of notional per side (0 = off, else 0.005–1)"
            />
          </label>
          <label title="Directional = baseline. Non-Directional = ORB+reverse. Pro = Lo/Sh/Se/Co + VWAP±Nσ.">
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
            <label title="Pro qualifier: AGGR candle must be outside Binance VWAP ±Nσ (05:30 IST)">
              VWAP σ
              <select
                value={params.pro_vwap_sigma}
                disabled={busy}
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
              <label
                title="Arm at 1× range from entry; move stop once to BE% × range (lock). TP still closes as LT/ST."
              >
                <input
                  type="checkbox"
                  checked={params.break_even === 1}
                  onChange={(e) => set('break_even', e.target.checked ? 1 : 0)}
                />
                BreakEven
              </label>
              {params.break_even === 1 && (
                <label title="BE lock as % of signal range from entry (default 50)">
                  BE%
                  <input
                    className="num-plain cost"
                    type="number"
                    inputMode="decimal"
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
          <label title="Long / Short / Both sides allowed">
            Sides
            <select
              value={params.trade_mode}
              onChange={(e) => set('trade_mode', Number(e.target.value))}
            >
              <option value={2}>Both</option>
              <option value={0}>Long</option>
              <option value={1}>Short</option>
            </select>
          </label>
        </div>

        <span className="strip-div" aria-hidden />

        <div className="strip-seg">
          <span className="strip-lab">TIME</span>
          <label title="IST — start looking for Aggressive candles from this time (default 05:30)">
            After
            <input
              type="time"
              value={minsToTime(params.entry_after)}
              onChange={(e) => set('entry_after', timeToMins(e.target.value))}
            />
          </label>
          <label title="IST — stop new AGGR / entries before this time (default 21:00)">
            Before
            <input
              type="time"
              value={minsToTime(params.entry_before)}
              onChange={(e) => set('entry_before', timeToMins(e.target.value))}
            />
          </label>
          <label title="IST — force flatten open trades at this clock">
            Flat
            <input
              type="time"
              value={minsToTime(params.exit_time)}
              onChange={(e) => set('exit_time', timeToMins(e.target.value))}
            />
          </label>
        </div>

        <span className="strip-div" aria-hidden />

        <div className="strip-seg strip-actions">
          <button disabled={busy} onClick={onRun}>
            {busy ? '…' : sessionStarted ? 'Run' : 'Run backtest'}
          </button>
          <button className="ghost" disabled={!data} onClick={onGoOptimize}>
            Optimize →
          </button>
        </div>
      </div>

      <div className="chart-area">
        <div className="subtabs tight">
          {(
            [
              ['charts', 'Visualization'],
              ['trades', 'Trades'],
              ['equity', 'Equity Curve'],
              ['performance', 'Performance'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={view === id ? 'active' : ''}
              onClick={() => onView(id)}
            >
              {label}
            </button>
          ))}
          {data && (
            <div className="chart-meta-pills">
              <span className={`pill ${net >= 0 ? 'ok' : 'bad'}`}>
                Net <b>{fmt2(net)}</b>
              </span>
              <span className="pill">
                Trades <b>{trades}</b>
              </span>
              <span className={`pill ${win >= 50 ? 'ok' : win > 0 ? '' : 'bad'}`}>
                Win <b>{fmt2(win)}%</b>
              </span>
            </div>
          )}
        </div>
        <div className="chart-fill">
          <ChartsTab data={data} visible={view === 'charts'} proMode={Boolean(params.pro_mode)} />
          {view === 'trades' && <TradesTab data={data} onOpenOnChart={() => onView('charts')} />}
          <EquityTab data={data} visible={view === 'equity'} />
          <PerformanceTab data={data} visible={view === 'performance'} />
        </div>
      </div>

      {view !== 'equity' && view !== 'performance' && <MetricsPanel stats={data?.stats || null} />}
    </div>
  )
}
