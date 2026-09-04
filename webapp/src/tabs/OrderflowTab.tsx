import { useMemo, useRef, useState } from 'react'
import { fetchOrderflowBars, type OrderflowBar } from '../api'
import { OrderflowChart } from './OrderflowChart'

type Layout = '1' | '2h' | '2v' | '2x2'

type Cell = {
  tf: number
  bars: OrderflowBar[] | null
  busy: boolean
  err: string | null
}

type Props = {
  exchange: string
  symbol: string
  start: string
  end: string
  tf: number
  dataReady: boolean
  active?: boolean
}

const TF_OPTS = [1, 3, 5, 15, 30, 60]
const LAYOUTS: { id: Layout; label: string; n: number }[] = [
  { id: '1', label: '1', n: 1 },
  { id: '2h', label: '2H', n: 2 },
  { id: '2v', label: '2V', n: 2 },
  { id: '2x2', label: '2×2', n: 4 },
]

function layoutCount(l: Layout): number {
  return LAYOUTS.find((x) => x.id === l)?.n ?? 1
}

function defaultTfs(base: number): number[] {
  const rest = TF_OPTS.filter((t) => t !== base)
  return [base, ...rest]
}

export function OrderflowTab({ exchange, symbol, start, end, tf, dataReady, active = true }: Props) {
  const [form, setForm] = useState({ exchange, symbol, start, end })
  const [layout, setLayout] = useState<Layout>('1')
  const [cells, setCells] = useState<Cell[]>(() =>
    defaultTfs(tf).slice(0, 4).map((t) => ({ tf: t, bars: null, busy: false, err: null })),
  )
  const cellsRef = useRef(cells)
  cellsRef.current = cells
  const [leftOpen, setLeftOpen] = useState(true)
  const [leftPinned, setLeftPinned] = useState(false)

  const n = layoutCount(layout)
  const shown = useMemo(() => cells.slice(0, n), [cells, n])

  const patchCell = (i: number, patch: Partial<Cell>) => {
    setCells((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  }

  const submitCell = async (i: number) => {
    const cell = cellsRef.current[i]
    if (!cell) return
    const cellTf = cell.tf
    patchCell(i, { busy: true, err: null })
    try {
      const r = await fetchOrderflowBars({
        exchange: form.exchange,
        symbol: form.symbol.trim().toUpperCase(),
        tf: cellTf,
        start: form.start,
        end: form.end,
      })
      patchCell(i, { bars: r.bars || [], busy: false, err: null })
      if (!leftPinned) setLeftOpen(false)
    } catch (e) {
      patchCell(i, {
        bars: null,
        busy: false,
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const submitAll = () => {
    for (let i = 0; i < n; i++) void submitCell(i)
  }

  const anyBusy = shown.some((c) => c.busy)
  const loaded = shown.some((c) => c.bars && c.bars.length > 0)

  return (
    <div className="of-shell">
      <div className="of-hud">
        <div
          className={`of-rail left${leftOpen ? ' open' : ''}${leftPinned ? ' pinned' : ''}`}
          onMouseEnter={() => setLeftOpen(true)}
          onMouseLeave={() => {
            if (!leftPinned) setLeftOpen(false)
          }}
        >
        <button
          type="button"
          className={`of-edge left${leftOpen ? ' on' : ''}`}
          title={leftOpen ? 'Hide data menu' : 'Show data menu'}
          onClick={() => setLeftOpen((v) => !v)}
        >
          DATA
        </button>
        <aside className={`of-drawer left${leftOpen ? ' open' : ''}`}>
          <div className="of-drawer-head">
            <b>Data</b>
            <button
              type="button"
              className={`ghost of-pin${leftPinned ? ' on' : ''}`}
              title={leftPinned ? 'Unpin (auto-hide)' : 'Pin open'}
              onClick={() => setLeftPinned((v) => !v)}
            >
              {leftPinned ? '📌' : '📍'}
            </button>
          </div>
          <label>
            Exchange
            <select
              value={form.exchange}
              onChange={(e) => setForm((f) => ({ ...f, exchange: e.target.value }))}
              disabled={anyBusy}
            >
              <option value="BINANCE_UM">Binance USD-M Futures</option>
            </select>
          </label>
          <label>
            Symbol
            <input
              value={form.symbol}
              onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value.toUpperCase() }))}
              disabled={anyBusy}
            />
          </label>
          <label title="Inclusive. 00:00 IST on this date.">
            Start (IST)
            <input
              type="date"
              value={form.start}
              onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))}
              disabled={anyBusy}
            />
          </label>
          <label title="Exclusive. Window ends at 00:00 IST on this date.">
            End (IST)
            <input
              type="date"
              value={form.end}
              onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))}
              disabled={anyBusy}
            />
          </label>
          <label>
            Layout
            <select value={layout} onChange={(e) => setLayout(e.target.value as Layout)} disabled={anyBusy}>
              {LAYOUTS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          {shown.map((cell, i) => (
            <label key={i}>
              {n > 1 ? `TF pane ${i + 1}` : 'Timeframe'}
              <select
                value={cell.tf}
                disabled={cell.busy}
                onChange={(e) => patchCell(i, { tf: Number(e.target.value) })}
              >
                {TF_OPTS.map((t) => (
                  <option key={t} value={t}>
                    {t}m
                  </option>
                ))}
              </select>
            </label>
          ))}
          {!dataReady && <p className="hint">Load ticks in Data Loader first.</p>}
          <button
            type="button"
            className="load-btn"
            disabled={anyBusy || !dataReady}
            onClick={submitAll}
          >
            {anyBusy ? 'Loading…' : n > 1 ? 'Submit all' : 'Submit'}
          </button>
          {shown.map((cell, i) =>
            cell.err ? (
              <div key={`e${i}`} className="error of-cell-err">
                {n > 1 ? `P${i + 1}: ` : ''}
                {cell.err}
              </div>
            ) : null,
          )}
          {loaded && (
            <p className="hint">
              {form.symbol} · {form.start} → {form.end}
              {shown[0]?.bars ? ` · ${shown[0].bars.length} bars` : ''}
            </p>
          )}
        </aside>
        </div>

        <div className={`of-grid l-${layout}`}>
          {shown.map((cell, i) => (
            <div key={i} className="of-cell">
              {cell.bars && cell.bars.length > 0 ? (
                <OrderflowChart bars={cell.bars} symbol={form.symbol} tf={cell.tf} visible={active} />
              ) : (
                <div className="of-empty">
                  {cell.busy ? 'Building bars…' : 'Open DATA (left edge) and Submit.'}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
