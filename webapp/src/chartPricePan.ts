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

function inMainPanePlot(chart: IChartApi, x: number, y: number, canvasW: number, canvasH: number): boolean {
  // Leave right price gutter + bottom time gutter to sschart.
  if (x > canvasW - 64) return false
  if (y > canvasH - 28) return false
  try {
    const size = mainPaneApi(chart)?.getSize()
    if (size) {
      return y >= size.top && y <= size.top + size.height - 2 && x < canvasW - 64
    }
  } catch {
    /* ignore */
  }
  // Fallback: upper ~55% of host is price pane.
  return y < canvasH * 0.55
}

/**
 * Enable click-drag on the candle area to pan price vertically
 * (sschart only pans time on pane drag; price-axis drag only zooms).
 *
 * - After Y zoom / frozen scale: vertical-dominant drag pans price.
 * - Always: Shift+drag pans price (and suppresses time pan).
 */
export function attachCandlePricePan(chart: IChartApi, host: HTMLElement): () => void {
  const canvas = host.querySelector('canvas')
  if (!canvas) return () => undefined

  let lastY: number | null = null
  let lastX: number | null = null
  let tracking = false
  let armed = false
  let forceY = false // Shift held at pointerdown
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
    if (!inMainPanePlot(chart, x, y, rect.width, rect.height)) return

    tracking = true
    armed = false
    forceY = e.shiftKey
    lastY = e.clientY
    lastX = e.clientX

    if (forceY || isPriceZoomed(chart)) {
      // Claim the gesture early so sschart does not start a time-pan.
      disableTimePan()
      if (forceY) {
        armed = true
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
      // After Y zoom prefer vertical pan; otherwise require clear vertical dominance.
      if (!zoomed && Math.abs(dy) <= Math.abs(dx) * 1.25) return
      if (zoomed && Math.abs(dy) < Math.abs(dx) * 0.55 && !forceY && !e.shiftKey) return
      armed = true
      disableTimePan()
    }

    if (Math.abs(dy) < 0.35) return
    const rect = canvas.getBoundingClientRect()
    const plotH = mainPanePlotHeight(chart, rect.height)
    if (panPriceByPixels(chart, dy, plotH)) {
      e.stopImmediatePropagation()
      e.preventDefault()
      canvas.style.cursor = 'ns-resize'
    }
  }

  const onUp = () => {
    tracking = false
    armed = false
    forceY = false
    lastY = null
    lastX = null
    restoreScroll()
  }

  // Capture phase so we can stop sschart's time-pan once we own the Y gesture.
  const opts: AddEventListenerOptions = { capture: true }
  canvas.addEventListener('pointerdown', onDown, opts)
  canvas.addEventListener('pointermove', onMove, opts)
  canvas.addEventListener('pointerup', onUp, opts)
  canvas.addEventListener('pointercancel', onUp, opts)
  window.addEventListener('pointerup', onUp)

  return () => {
    onUp()
    canvas.removeEventListener('pointerdown', onDown, opts)
    canvas.removeEventListener('pointermove', onMove, opts)
    canvas.removeEventListener('pointerup', onUp, opts)
    canvas.removeEventListener('pointercancel', onUp, opts)
    window.removeEventListener('pointerup', onUp)
  }
}
