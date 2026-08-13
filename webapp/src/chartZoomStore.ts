/** Persist chart visible range across Visualization / Trades / Optimize tab switches. */
export type LogicalRange = { from: number; to: number }

let saved: LogicalRange | null = null

export function saveChartRange(range: LogicalRange | null) {
  if (!range) return
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) return
  saved = { from: range.from, to: range.to }
}

export function loadChartRange(): LogicalRange | null {
  return saved
}

export function clearChartRange() {
  saved = null
}
