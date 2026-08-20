import type { IChartApi, ISeriesApi } from '@stocksharp/chart'

export type MarkerLabel = {
  time: number
  /** Anchor price (high/low of bar or exit fill) */
  price: number
  position: 'aboveBar' | 'belowBar'
  color: string
  line1: string
  line2: string
}

/**
 * Overlay canvas for two-line trade labels with font auto-fit.
 * sschart SeriesMarkers only draw a single fillText line at fixed 10px.
 */
export function attachMarkerLabels(
  host: HTMLElement,
  chart: IChartApi,
  series: ISeriesApi,
  labels: MarkerLabel[],
): () => void {
  if (!labels.length) return () => undefined

  host.style.position = host.style.position || 'relative'
  const overlay = document.createElement('canvas')
  overlay.className = 'chart-marker-labels'
  overlay.style.cssText =
    'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:3'
  host.appendChild(overlay)

  const paint = () => {
    const w = host.clientWidth
    const h = host.clientHeight
    if (w < 2 || h < 2) return
    const dpr = window.devicePixelRatio || 1
    overlay.width = Math.floor(w * dpr)
    overlay.height = Math.floor(h * dpr)
    overlay.style.width = `${w}px`
    overlay.style.height = `${h}px`
    const ctx = overlay.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const logical = chart.timeScale().getVisibleLogicalRange()
    const visibleBars = logical ? Math.max(1, logical.to - logical.from) : 40
    const barPx = Math.max(1, (w - 64) / visibleBars)
    // Labels collide into a solid band when zoomed out — skip them.
    if (barPx < 7) return
    const maxTextW = Math.max(36, Math.min(120, barPx * 2.4))

    for (const lab of labels) {
      const x = chart.timeScale().timeToCoordinate(lab.time as never)
      const yPrice = series.priceToCoordinate(lab.price)
      if (x === null || yPrice === null) continue
      if (x < -40 || x > w + 40) continue

      let fontSize = Math.min(11, Math.max(7, Math.round(barPx * 0.55)))
      ctx.textAlign = 'center'
      let lineH = fontSize + 1
      let w1 = 0
      let w2 = 0
      for (; fontSize >= 7; fontSize -= 1) {
        ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`
        w1 = ctx.measureText(lab.line1).width
        ctx.font = `500 ${fontSize}px ui-sans-serif, system-ui, sans-serif`
        w2 = ctx.measureText(lab.line2).width
        lineH = fontSize + 1
        if (Math.max(w1, w2) <= maxTextW) break
      }

      const blockH = lineH * 2 + 2
      const above = lab.position === 'aboveBar'
      // Keep clear of the native circle marker (~14px from bar)
      const gap = 18
      const top = above ? yPrice - gap - blockH : yPrice + gap

      ctx.fillStyle = lab.color
      ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`
      ctx.textBaseline = 'top'
      ctx.fillText(lab.line1, x, top)
      ctx.font = `500 ${fontSize}px ui-sans-serif, system-ui, sans-serif`
      ctx.globalAlpha = 0.92
      ctx.fillText(lab.line2, x, top + lineH + 1)
      ctx.globalAlpha = 1
    }
  }

  paint()
  const onRange = () => paint()
  chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
  const ro = new ResizeObserver(() => paint())
  ro.observe(host)
  window.addEventListener('resize', paint)

  return () => {
    chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
    ro.disconnect()
    window.removeEventListener('resize', paint)
    overlay.remove()
  }
}
