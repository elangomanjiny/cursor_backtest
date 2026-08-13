import { useCallback, useEffect, useState } from 'react'
import { fetchBars, type OhlcvBar } from '../api'
import { fmt2 } from '../format'
import { SortTh, useSortable } from '../useSortable'

type Props = {
  exchange: string
  symbol: string
  start: string
  end: string
  tf: number
  busy: boolean
  dataReady: boolean
  onChange: (patch: {
    exchange?: string
    symbol?: string
    start?: string
    end?: string
    tf?: number
  }) => void
  onLoad: () => void
}

const TF_OPTS = [1, 3, 5, 15, 30, 60]

export function DataLoaderStep({
  exchange,
  symbol,
  start,
  end,
  tf,
  busy,
  dataReady,
  onChange,
  onLoad,
}: Props) {
  const [tableTf, setTableTf] = useState(tf)
  const [rows, setRows] = useState<OhlcvBar[]>([])
  const [tableBusy, setTableBusy] = useState(false)

  useEffect(() => {
    setTableTf(tf)
  }, [tf])

  useEffect(() => {
    if (!dataReady) {
      setRows([])
      return
    }
    let cancelled = false
    setTableBusy(true)
    void fetchBars({ symbol, tf: tableTf, start, end })
      .then((r) => {
        if (!cancelled) setRows(r.bars)
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
      .finally(() => {
        if (!cancelled) setTableBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [dataReady, symbol, start, end, tableTf])

  const barGet = useCallback((row: OhlcvBar, key: string): unknown => {
    return (row as unknown as Record<string, unknown>)[key]
  }, [])
  const barSort = useSortable(rows, barGet, { key: 'time', dir: 'asc' })

  return (
    <div className="panel step-panel">
      <h2 className={dataReady ? 'title-ready' : 'title-idle'}>Step 1 — Data Loader</h2>
      <p className="hint">
        Pull Binance USD-M futures aggTrades, then build OHLCV + delta bars. Supports up to ~1
        year (day-by-day download; large ranges need disk + time). For live prep: load IS window,
        optimize, then change dates to an OOS window and re-backtest without re-fitting.
      </p>

      <div className="loader-row">
        <label>
          Exchange
          <select
            value={exchange}
            onChange={(e) => onChange({ exchange: e.target.value })}
            disabled={busy}
          >
            <option value="BINANCE_UM">Binance USD-M Futures</option>
          </select>
        </label>
        <label>
          Symbol
          <input
            value={symbol}
            onChange={(e) => onChange({ symbol: e.target.value.toUpperCase() })}
            disabled={busy}
          />
        </label>
        <label>
          Start date (UTC)
          <input
            type="date"
            value={start}
            onChange={(e) => onChange({ start: e.target.value })}
            disabled={busy}
          />
        </label>
        <label>
          End date (UTC, exclusive)
          <input
            type="date"
            value={end}
            onChange={(e) => onChange({ end: e.target.value })}
            disabled={busy}
          />
        </label>
        <label>
          Timeframe
          <select
            value={tf}
            onChange={(e) => onChange({ tf: Number(e.target.value) })}
            disabled={busy}
          >
            {TF_OPTS.map((t) => (
              <option key={t} value={t}>
                {t}m
              </option>
            ))}
          </select>
        </label>
        <button className="load-btn" disabled={busy} onClick={onLoad}>
          {busy ? 'Loading…' : 'Load data'}
        </button>
      </div>

      {dataReady && (
        <div className="ohlcv-block">
          <div className="ohlcv-head">
            <h3>Loaded OHLCV</h3>
            <label className="inline-tf">
              Table TF
              <select
                value={tableTf}
                onChange={(e) => setTableTf(Number(e.target.value))}
                disabled={tableBusy}
              >
                {TF_OPTS.map((t) => (
                  <option key={t} value={t}>
                    {t}m
                  </option>
                ))}
              </select>
            </label>
            <span className="hint" style={{ margin: 0 }}>
              {tableBusy ? 'Refreshing…' : `${rows.length} bars`} · click headers to sort
            </span>
          </div>
          <div className="table-scroll ohlcv-table">
            <table>
              <thead>
                <tr>
                  <SortTh col="time" sort={barSort.sort} onSort={barSort.toggle}>
                    DateTime
                  </SortTh>
                  <SortTh col="open" sort={barSort.sort} onSort={barSort.toggle}>
                    Open
                  </SortTh>
                  <SortTh col="high" sort={barSort.sort} onSort={barSort.toggle}>
                    High
                  </SortTh>
                  <SortTh col="low" sort={barSort.sort} onSort={barSort.toggle}>
                    Low
                  </SortTh>
                  <SortTh col="close" sort={barSort.sort} onSort={barSort.toggle}>
                    Close
                  </SortTh>
                  <SortTh col="volume_quote" sort={barSort.sort} onSort={barSort.toggle}>
                    Vol (USDT)
                  </SortTh>
                  <SortTh col="volume_base" sort={barSort.sort} onSort={barSort.toggle}>
                    Vol (base)
                  </SortTh>
                  <SortTh col="delta_quote" sort={barSort.sort} onSort={barSort.toggle}>
                    Δ USDT
                  </SortTh>
                  <SortTh col="delta_pct" sort={barSort.sort} onSort={barSort.toggle}>
                    Δ%
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {barSort.sorted.map((b, i) => (
                  <tr key={`${b.time}-${i}`}>
                    <td>{b.time.replace('T', ' ').slice(0, 19)}</td>
                    <td>{fmt2(b.open)}</td>
                    <td>{fmt2(b.high)}</td>
                    <td>{fmt2(b.low)}</td>
                    <td>{fmt2(b.close)}</td>
                    <td>{fmt2(b.volume_quote)}</td>
                    <td>{fmt2(b.volume_base)}</td>
                    <td className={b.delta_quote >= 0 ? 'pos' : 'neg'}>{fmt2(b.delta_quote)}</td>
                    <td className={b.delta_pct >= 0 ? 'pos' : 'neg'}>{fmt2(b.delta_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
