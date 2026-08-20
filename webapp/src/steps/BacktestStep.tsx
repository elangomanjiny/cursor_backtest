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

/** Slip/Fee input: percent of price (0 = off). Allow 0.001% … 5%. */
function clampCostPct(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(5, Math.max(0.001, n))
}

const DIST_UNITS = ['range', 'tick', 'points', 'pct'] as const
type DistUnit = (typeof DIST_UNITS)[number]

function asDistUnit(raw: string): DistUnit | null {
  return DIST_UNITS.includes(raw as DistUnit) ? (raw as DistUnit) : null
}

function unitLabel(u: DistUnit, rangeText: string): string {
  if (u === 'range') return rangeText
  if (u === 'tick') return 'Tick'
  if (u === 'points') return 'Points'
  return '%'
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
              onChange={(e) => {
                const tf = Number(e.target.value)
                if (params.pro_mtf_mode && params.base_tf <= tf) {
                  const nextBase =
                    ([15, 30, 60] as const).find((x) => x > tf) ?? Math.max(tf * 2, 15)
                  setMany({ tf, base_tf: nextBase })
                } else {
                  set('tf', tf)
                }
              }}
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
          <label
            className="check"
            title="When off: no LSL/SSL from this box. Trail and BreakEven still work independently."
          >
            <input
              type="checkbox"
              checked={params.sl_on === 1}
              onChange={(e) => {
                const on = e.target.checked
                onParams((prev) => ({
                  ...prev,
                  sl_on: on ? 1 : 0,
                  risk_on: on || prev.tp_on === 1 ? 1 : 0,
                }))
              }}
            />
            Stoploss
          </label>
          {params.sl_on === 1 && (
            <>
              <label title="How the stop is measured from entry (Range = AGGR high/low)">
                SL mode
                <select
                  value={params.sl_unit}
                  onChange={(e) => {
                    const u = asDistUnit(e.target.value)
                    if (u) set('sl_unit', u)
                  }}
                >
                  <option value="range">Range</option>
                  <option value="tick">Tick</option>
                  <option value="points">Points</option>
                  <option value="pct">%</option>
                </select>
              </label>
              {params.sl_unit !== 'range' && (
                <label
                  title={
                    params.sl_unit === 'tick'
                      ? 'Stop loss in ticks'
                      : params.sl_unit === 'points'
                        ? 'Stop loss in price points'
                        : 'Stop loss as % of entry price'
                  }
                >
                  SL
                  <input
                    className="num-plain"
                    type="number"
                    inputMode="decimal"
                    step={params.sl_unit === 'pct' ? '0.01' : '1'}
                    min={0}
                    value={params.stop_loss}
                    onChange={(e) => set('stop_loss', Number(e.target.value))}
                  />
                </label>
              )}
            </>
          )}
          <label
            className="check"
            title="When off: no LT/ST from this box. Stoploss, Trail and BreakEven still work independently."
          >
            <input
              type="checkbox"
              checked={params.tp_on === 1}
              onChange={(e) => {
                const on = e.target.checked
                onParams((prev) => ({
                  ...prev,
                  tp_on: on ? 1 : 0,
                  risk_on: on || prev.sl_on === 1 ? 1 : 0,
                }))
              }}
            />
            Target
          </label>
          {params.tp_on === 1 && (
            <>
              <label title="How the target is measured from entry (Range = AGGR range × RR)">
                TP mode
                <select
                  value={params.tp_unit}
                  onChange={(e) => {
                    const u = asDistUnit(e.target.value)
                    if (u) set('tp_unit', u)
                  }}
                >
                  <option value="range">Range×RR</option>
                  <option value="tick">Tick</option>
                  <option value="points">Points</option>
                  <option value="pct">%</option>
                </select>
              </label>
              {params.tp_unit === 'range' ? (
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
              ) : (
                <label
                  title={
                    params.tp_unit === 'tick'
                      ? 'Take profit in ticks'
                      : params.tp_unit === 'points'
                        ? 'Take profit in price points'
                        : 'Take profit as % of entry price'
                  }
                >
                  TP
                  <input
                    className="num-plain"
                    type="number"
                    inputMode="decimal"
                    step={params.tp_unit === 'pct' ? '0.01' : '1'}
                    min={0}
                    value={params.take_profit}
                    onChange={(e) => set('take_profit', Number(e.target.value))}
                  />
                </label>
              )}
            </>
          )}
          <label
            className="check"
            title="Trail a stop by Trail distance as price moves in your favor. Independent of Stoploss and Target."
          >
            <input
              type="checkbox"
              checked={params.trail_stop === 1}
              onChange={(e) => set('trail_stop', e.target.checked ? 1 : 0)}
            />
            Trail
          </label>
          {params.trail_stop === 1 && (
            <>
              <label title="Trail offset unit. Range = AGGR high/low gap.">
                Trail unit
                <select
                  value={params.trail_unit}
                  onChange={(e) => {
                    const u = asDistUnit(e.target.value)
                    if (u) set('trail_unit', u)
                  }}
                >
                  <option value="range">Range</option>
                  <option value="tick">Tick</option>
                  <option value="points">Points</option>
                  <option value="pct">%</option>
                </select>
              </label>
              {params.trail_unit !== 'range' && (
                <label title={`Trail distance in ${unitLabel(params.trail_unit, 'Range')}`}>
                  Trail
                  <input
                    className="num-plain"
                    type="number"
                    inputMode="decimal"
                    step={params.trail_unit === 'pct' ? '0.01' : '1'}
                    min={0}
                    value={params.trail_value}
                    onChange={(e) => set('trail_value', Number(e.target.value))}
                  />
                </label>
              )}
            </>
          )}
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
          <label title="Slippage as % of fill price (both sides). 0.01 = 0.01%">
            Slip%
            <input
              className="num-plain cost"
              type="number"
              inputMode="decimal"
              step="0.001"
              min={0}
              max={5}
              value={params.slippage_pct}
              onChange={(e) => set('slippage_pct', Number(e.target.value))}
              onBlur={() => set('slippage_pct', clampCostPct(params.slippage_pct))}
              title="Slippage as % of fill price (both sides). Example: 0.01 = 0.01%"
            />
          </label>
          <label title="Fee as % of notional per side (entry + exit). 0.04 = 0.04%">
            Fee%
            <input
              className="num-plain cost"
              type="number"
              inputMode="decimal"
              step="0.001"
              min={0}
              max={5}
              value={params.fee_pct}
              onChange={(e) => set('fee_pct', Number(e.target.value))}
              onBlur={() => set('fee_pct', clampCostPct(params.fee_pct))}
              title="Fee as % of notional per side (entry + exit). Example: 0.04 = 0.04%"
            />
          </label>
          <label title="Directional = baseline. Non-Directional = ORB+reverse. Pro = VWAP tags. Pro-MTF = HTF bias + LTF Directional.">
            Strategy
            <select
              value={
                params.pro_mtf_mode
                  ? 'pro_mtf'
                  : params.pro_mode
                    ? 'pro'
                    : params.wait_and_trade
                      ? 'non_directional'
                      : 'directional'
              }
              onChange={(e) => {
                const v = e.target.value
                const nd = v === 'non_directional'
                const pro = v === 'pro'
                const mtf = v === 'pro_mtf'
                setMany({
                  wait_and_trade: nd,
                  pro_mode: pro,
                  pro_mtf_mode: mtf,
                  re_entry: 0,
                  stop_to_be: 0,
                  ...(mtf && params.base_tf <= params.tf
                    ? {
                        base_tf: ([15, 30, 60] as const).find((x) => x > params.tf) ?? 15,
                      }
                    : {}),
                })
              }}
            >
              <option value="directional">Directional</option>
              <option value="non_directional">Non-Directional</option>
              <option value="pro">Pro</option>
              <option value="pro_mtf">Pro-MTF</option>
            </select>
          </label>
          {params.pro_mtf_mode && (
            <>
              <label title="Higher timeframe for bull/bear AGGR bias (must be > chart TF)">
                Base TF
                <select
                  value={params.base_tf}
                  disabled={busy}
                  onChange={(e) => set('base_tf', Number(e.target.value))}
                >
                  {[3, 5, 15, 30, 60]
                    .filter((m) => m > params.tf)
                    .map((m) => (
                      <option key={m} value={m}>
                        {m}m
                      </option>
                    ))}
                </select>
              </label>
              <label title="AGGR |Δ%| threshold on the base timeframe">
                Base Thr%
                <input
                  className="num-plain"
                  type="number"
                  inputMode="decimal"
                  step="1"
                  min={0}
                  value={params.base_threshold}
                  onChange={(e) => set('base_threshold', Number(e.target.value))}
                />
              </label>
            </>
          )}
          {params.pro_mode && !params.pro_mtf_mode && (
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
          <label
            title="On: after price reaches the arm, move stop once. Range/% = old method (arm at AGGR 1R). Tick/Points = arm at the typed distance, lock at entry. Independent of Stoploss and Target. Hit after lock = LB/SB."
          >
            <input
              type="checkbox"
              checked={params.break_even === 1}
              onChange={(e) => set('break_even', e.target.checked ? 1 : 0)}
            />
            BreakEven
          </label>
          {params.break_even === 1 && (
            <>
              <label title="Range/%: old method, arm at AGGR 1R. Tick/Points: arm at BE input, lock at entry.">
                BE unit
                <select
                  value={params.be_unit}
                  onChange={(e) => {
                    const u = asDistUnit(e.target.value)
                    if (u) set('be_unit', u)
                  }}
                >
                  <option value="range">Range</option>
                  <option value="tick">Tick</option>
                  <option value="points">Points</option>
                  <option value="pct">%</option>
                </select>
              </label>
              {params.be_unit !== 'range' && (
                <label
                  title={
                    params.be_unit === 'pct'
                      ? 'Old BE%: lock this % of AGGR range (arms at 1R). 50 = halfway.'
                      : params.be_unit === 'tick'
                        ? 'Arm after this many ticks of profit, then move stop to entry'
                        : 'Arm after this many points of profit, then move stop to entry'
                  }
                >
                  BE
                  <input
                    className="num-plain"
                    type="number"
                    inputMode="decimal"
                    step={params.be_unit === 'pct' ? '1' : '1'}
                    min={params.be_unit === 'pct' ? 1 : 0}
                    max={params.be_unit === 'pct' ? 100 : undefined}
                    value={params.be_value}
                    onChange={(e) => set('be_value', Number(e.target.value))}
                    onBlur={() => {
                      if (params.be_unit === 'pct') {
                        set(
                          'be_value',
                          Math.min(100, Math.max(1, Number(params.be_value) || 50)),
                        )
                      }
                    }}
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
          <ChartsTab
            data={data}
            visible={view === 'charts'}
            proMode={Boolean(params.pro_mode)}
            proMtfMode={Boolean(params.pro_mtf_mode)}
          />
          {view === 'trades' && <TradesTab data={data} onOpenOnChart={() => onView('charts')} />}
          <EquityTab data={data} visible={view === 'equity'} />
          <PerformanceTab data={data} visible={view === 'performance'} />
        </div>
      </div>

      {view !== 'equity' && view !== 'performance' && <MetricsPanel stats={data?.stats || null} />}
    </div>
  )
}
