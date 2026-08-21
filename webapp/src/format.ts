/** Display / serialize numbers with 2 decimal places. */
export function fmt2(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(Number(n))) return '—'
  return Number(n).toFixed(2)
}

/** Quote costs (slip / fee). 4 dp so 0.01-lot ETH fees like 0.0037 are visible. */
export function fmtCost(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(Number(n))) return '—'
  return Number(n).toFixed(4)
}

/** Format a percentage; clamps extreme values and maps non-finite → N/A. */
export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(Number(n))) return 'N/A'
  const clamped = Math.max(-9999.99, Math.min(9999.99, Number(n)))
  return clamped.toFixed(digits)
}

export function num2(n: number): number {
  return Math.round(n * 100) / 100
}
