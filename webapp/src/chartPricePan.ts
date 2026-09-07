import type { IChartApi, IPaneApi } from '@stocksharp/chart'

/** Best-effort access to sschart internals (priceZoom / frozenRange). */
type PaneScale = {
  frozenRange: {
    min: number
    max: number
    mode?: number
    baseValue?: number
    baseValues?: ReadonlyMap<object, number>
  } | null
}

type PaneInternal = {
  priceZoom: number
  priceScale: (id: string) => PaneScale
}

type ChartInternal = {
  model?: { mainPane?: PaneInternal; panes?: PaneInternal[] }
  scheduleDraw?: (...args: unknown[]) => void
  opts?: { handleScroll?: boolean | { pressedMouseMove?: boolean; mouseWheel?: boolean } }
}

function asInternal(chart: IChartApi): ChartInternal {
  return chart as unknown as ChartInternal
}

function mainPaneInternal(chart: IChartApi): PaneInternal | null {
  const c = asInternal(chart)
  return c.model?.mainPane ?? c.model?.panes?.[0] ?? null
}

function mainPaneApi(chart: IChartApi): IPaneApi | null {
  try {
    return chart.panes()[0] ?? null
  } catch {
    return null
  }
}

/** Width of the right price scale, used to keep overlays and gestures off the labels. */
export function priceScaleGutter(chart: IChartApi, hostWidth?: number, hostEl?: HTMLElement | null): number {
  const MIN = 108
  const read = (fn: () => number | undefined): number | null => {
    try {
      const w = fn()
      if (typeof w === 'number' && Number.isFinite(w) && w >= 8) return Math.ceil(w)
    } catch {
      /* ignore */
    }
    return null
  }
  const plotW = read(() => (chart.timeScale() as { width?: () => number }).width?.())
  const full = hostWidth != null && hostWidth > 40 ? hostWidth : null
  let gutter = MIN
  if (plotW != null && full != null && full > plotW + 24) {
    const raw = full - plotW
    // Ignore huge gaps — they mean timeScale.width() is stale after a layout change.
    if (raw <= 160) gutter = Math.max(MIN, raw)
  } else {
    const scaleW =
      read(() => (chart.priceScale('right') as { width?: () => number }).width?.()) ??
      read(() => {
        const pane = mainPaneApi(chart)
        return (pane?.priceScale('right') as { width?: () => number } | undefined)?.width?.()
      })
    gutter = Math.max(MIN, scaleW ?? MIN)
  }
  if (hostEl) {
    const tds = hostEl.querySelectorAll('td')
    for (const td of tds) {
      const node = td as HTMLElement
      const cw = node.offsetWidth
      const ch = node.offsetHeight
      if (cw >= 48 && cw <= 160 && ch > 60) gutter = Math.max(gutter, Math.ceil(cw))
    }
  }
  return Math.min(160, Math.max(MIN, gutter))
}

/** Keep series paint inside the plot cell so candles cannot cover the right price scale. */
export function clipPlotCanvases(host: HTMLElement, chart: IChartApi): void {
  const gutter = priceScaleGutter(chart, host.clientWidth, host)
  host.style.setProperty('--price-gutter', `${gutter}px`)
  host.parentElement?.style.setProperty('--price-gutter', `${gutter}px`)
  const tds = [...host.querySelectorAll('td')] as HTMLElement[]
  for (const td of tds) {
    const w = td.offsetWidth
    const h = td.offsetHeight
    const isPriceScale = w >= 48 && w <= 180 && h > 60
    td.style.overflow = isPriceScale ? 'visible' : 'hidden'
  }
}

function rightScale(pane: PaneInternal): PaneScale | null {
  try {
    return pane.priceScale('right')
  } catch {
    return null
  }
}

/** Freeze current visible Y range (bakes priceZoom into frozenRange). */
function freezePriceScale(chart: IChartApi): PaneScale | null {
  const pane = mainPaneInternal(chart)
  const api = mainPaneApi(chart)
  if (!pane || !api) return null
  const scale = rightScale(pane)
  if (!scale) return null

  if (scale.frozenRange === null) {
    try {
      api.priceScale('right').applyOptions({ autoScale: false })
    } catch {
      try {
        chart.priceScale('right').applyOptions({ autoScale: false })
      } catch {
        return null
      }
    }
  }

  // Zoom is now encoded in frozenRange — keep priceZoom neutral.
  pane.priceZoom = 1
  return scale.frozenRange ? scale : null
}

/** Fit the right price scale to candle high/low only (ignore VWAP / overlays). */
export function fitPriceToCandles(
  chart: IChartApi,
  bars: ReadonlyArray<{ high: number; low: number }>,
  logical?: { from: number; to: number } | null,
): void {
  if (!bars.length) return
  const r = logical ?? chart.timeScale().getVisibleLogicalRange()
  let lo = Infinity
  let hi = -Infinity
  if (r) {
    const a = Math.max(0, Math.floor(r.from))
    const b = Math.min(bars.length - 1, Math.ceil(r.to))
    for (let i = a; i <= b; i++) {
      const bar = bars[i]
      if (!bar) continue
      lo = Math.min(lo, Number(bar.low))
      hi = Math.max(hi, Number(bar.high))
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    for (const bar of bars) {
      lo = Math.min(lo, Number(bar.low))
      hi = Math.max(hi, Number(bar.high))
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return
  const pad = Math.max((hi - lo) * 0.08, (Math.abs(hi) + Math.abs(lo)) * 1e-6, 1e-8)
  const pane = mainPaneInternal(chart)
  const api = mainPaneApi(chart)
  if (!pane) return
  const scale = rightScale(pane)
  if (!scale) return
  try {
    api?.priceScale('right').applyOptions({ autoScale: false })
  } catch {
    try {
      chart.priceScale('right').applyOptions({ autoScale: false })
    } catch {
      /* ignore */
    }
  }
  pane.priceZoom = 1
  scale.frozenRange = {
    min: lo - pad,
    max: hi + pad,
    mode: scale.frozenRange?.mode,
    baseValue: scale.frozenRange?.baseValue,
    baseValues: scale.frozenRange?.baseValues,
  }
  asInternal(chart).scheduleDraw?.()
}

/** Reset vertical price zoom/pan; keep current time (X) zoom if possible. */
export function resetPriceOnly(chart: IChartApi): void {
  const logical = chart.timeScale().getVisibleLogicalRange()
  const c = asInternal(chart)
  const panes = c.model?.panes ?? (c.model?.mainPane ? [c.model.mainPane] : [])
  for (const p of panes) {
    p.priceZoom = 1
    try {
      p.priceScale('right').frozenRange = null
    } catch {
      /* ignore */
    }
  }
  try {
    const api = mainPaneApi(chart)
    api?.priceScale('right').applyOptions({ autoScale: true })
  } catch {
    try {
      chart.priceScale('right').applyOptions({ autoScale: true })
    } catch {
      /* ignore */
    }
  }
  if (logical) {
    try {
      chart.timeScale().setVisibleLogicalRange(logical)
    } catch {
      /* ignore */
    }
  }
  c.scheduleDraw?.()
}

/**
 * Shift the visible price window by pixel delta (drag down → higher prices).
 * Freezes Y on first vertical pan so zoomed candles can move.
 */
/** Stretch/compress the price window (axis drag). Mouse down zooms in. */
export function zoomPriceByPixels(chart: IChartApi, dy: number, plotHeight: number): boolean {
  if (!dy || plotHeight <= 0) return false
  const scale = freezePriceScale(chart)
  if (!scale?.frozenRange) return false
  const fr = scale.frozenRange
  const span = fr.max - fr.min
  if (!(span > 0)) return false
  const factor = Math.exp((-dy / plotHeight) * 2.2)
  const mid = (fr.max + fr.min) / 2
  const half = Math.max(span * 0.02, (span * factor) / 2, 1e-8)
  fr.min = mid - half
  fr.max = mid + half
  asInternal(chart).scheduleDraw?.()
  return true
}

export function panPriceByPixels(chart: IChartApi, dy: number, plotHeight: number): boolean {
  if (!dy || plotHeight <= 0) return false
  const scale = freezePriceScale(chart)
  if (!scale?.frozenRange) return false

  const fr = scale.frozenRange
  const span = fr.max - fr.min
  if (!(span > 0)) return false

  const shift = (dy / plotHeight) * span
  // Mutate in place so mode / baseValue / baseValues stay intact.
  fr.min += shift
  fr.max += shift
  asInternal(chart).scheduleDraw?.()
  return true
}

function isPriceZoomed(chart: IChartApi): boolean {
  const pane = mainPaneInternal(chart)
  if (!pane) return false
  const scale = rightScale(pane)
  if (scale?.frozenRange) return true
  return Math.abs(pane.priceZoom - 1) > 0.02
}

function mainPanePlotHeight(chart: IChartApi, canvasHeight: number): number {
  try {
    const size = mainPaneApi(chart)?.getSize()
    if (size && size.height > 8) return Math.max(1, size.height - 8)
  } catch {
    /* ignore */
  }
  return Math.max(1, canvasHeight * 0.55)
}

function inPriceGutter(chart: IChartApi, x: number, y: number, canvasW: number, canvasH: number): boolean {
  const gutter = priceScaleGutter(chart, canvasW)
  if (x < canvasW - gutter) return false
  if (y > canvasH - 28) return false
  try {
    const size = mainPaneApi(chart)?.getSize()
    if (size) return y >= size.top && y <= size.top + size.height - 2
  } catch {
    /* ignore */
  }
  return y < canvasH * 0.55
}

function inMainPanePlot(chart: IChartApi, x: number, y: number, canvasW: number, canvasH: number): boolean {
  const gutter = priceScaleGutter(chart, canvasW)
  if (x >= canvasW - gutter) return false
  if (y > canvasH - 28) return false
  try {
    const size = mainPaneApi(chart)?.getSize()
    if (size) {
      return y >= size.top && y <= size.top + size.height - 2 && x < canvasW - gutter
    }
  } catch {
    /* ignore */
  }
  return y < canvasH * 0.55
}

/**
 * Price-axis drag stretches Y. Plot drag (after stretch, or vertical / Shift)
 * pans candles up and down.
 */
export function attachCandlePricePan(chart: IChartApi, host: HTMLElement): () => void {
  const canvas = host.querySelector('canvas')
  if (!canvas) return () => undefined

  let lastY: number | null = null
  let lastX: number | null = null
  let tracking = false
  let armed = false
  let mode: 'plot' | 'axis' | null = null
  let forceY = false
  let savedScroll:
    | boolean
    | { pressedMouseMove?: boolean; mouseWheel?: boolean }
    | undefined

  const restoreScroll = () => {
    if (savedScroll === undefined) return
    try {
      chart.applyOptions({ handleScroll: savedScroll })
    } catch {
      /* ignore */
    }
    savedScroll = undefined
  }

  const disableTimePan = () => {
    if (savedScroll !== undefined) return
    const cur = asInternal(chart).opts?.handleScroll
    savedScroll = cur === undefined ? true : cur
    try {
      chart.applyOptions({
        handleScroll: {
          mouseWheel: typeof cur === 'object' && cur ? cur.mouseWheel !== false : true,
          pressedMouseMove: false,
        },
      })
    } catch {
      /* ignore */
    }
  }

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const axis = inPriceGutter(chart, x, y, rect.width, rect.height)
    const plot = inMainPanePlot(chart, x, y, rect.width, rect.height)
    if (!axis && !plot) return

    tracking = true
    armed = axis
    mode = axis ? 'axis' : 'plot'
    forceY = e.shiftKey
    lastY = e.clientY
    lastX = e.clientX

    if (axis || forceY || isPriceZoomed(chart)) {
      disableTimePan()
      if (axis || forceY) {
        e.stopImmediatePropagation()
        e.preventDefault()
      }
    }
  }

  const onMove = (e: PointerEvent) => {
    if (!tracking || lastY === null || lastX === null || (e.buttons & 1) === 0) return
    const dy = e.clientY - lastY
    const dx = e.clientX - lastX
    lastY = e.clientY
    lastX = e.clientX

    if (!armed) {
      if (Math.abs(dy) < 2 && Math.abs(dx) < 2) return
      const zoomed = isPriceZoomed(chart) || forceY || e.shiftKey
      if (!zoomed && Math.abs(dy) <= Math.abs(dx) * 1.25) return
      if (zoomed && Math.abs(dy) < Math.abs(dx) * 0.55 && !forceY && !e.shiftKey) return
      armed = true
      disableTimePan()
    }

    if (Math.abs(dy) < 0.35) return
    const rect = canvas.getBoundingClientRect()
    const plotH = mainPanePlotHeight(chart, rect.height)
    const ok = mode === 'axis' ? zoomPriceByPixels(chart, dy, plotH) : panPriceByPixels(chart, dy, plotH)
    if (ok) {
      e.stopImmediatePropagation()
      e.preventDefault()
      canvas.style.cursor = mode === 'axis' ? 'ns-resize' : 'move'
    }
  }

  const onUp = () => {
    tracking = false
    armed = false
    forceY = false
    mode = null
    lastY = null
    lastX = null
    canvas.style.cursor = ''
    restoreScroll()
  }

  const onWheel = (e: WheelEvent) => {
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (!inPriceGutter(chart, x, y, rect.width, rect.height)) return
    const plotH = mainPanePlotHeight(chart, rect.height)
    if (zoomPriceByPixels(chart, -e.deltaY, plotH)) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  }

  const opts: AddEventListenerOptions = { capture: true }
  canvas.addEventListener('pointerdown', onDown, opts)
  canvas.addEventListener('pointermove', onMove, opts)
  canvas.addEventListener('pointerup', onUp, opts)
  canvas.addEventListener('pointercancel', onUp, opts)
  canvas.addEventListener('wheel', onWheel, { capture: true, passive: false })
  window.addEventListener('pointerup', onUp)

  return () => {
    onUp()
    canvas.removeEventListener('pointerdown', onDown, opts)
    canvas.removeEventListener('pointermove', onMove, opts)
    canvas.removeEventListener('pointerup', onUp, opts)
    canvas.removeEventListener('pointercancel', onUp, opts)
    canvas.removeEventListener('wheel', onWheel, opts)
    window.removeEventListener('pointerup', onUp)
  }
}
