/** Min / max / step → comma list for the optimize API. */

export type NumRange = { min: number; max: number; step: number }

export function expandNumRange(r: NumRange, limit = 500): string {
  const min = Number(r.min)
  const max = Number(r.max)
  const step = Number(r.step)
  if (!Number.isFinite(min)) return '0'
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(max) || max < min) {
    return String(min)
  }
  const out: number[] = []
  const n = Math.floor((max - min) / step + 1e-9) + 1
  for (let i = 0; i < Math.min(n, limit); i++) {
    const v = min + i * step
    if (v > max + Math.abs(step) * 1e-9) break
    out.push(Number(v.toPrecision(12)))
  }
  return (out.length ? out : [min]).join(',')
}

export function countRange(r: NumRange): number {
  const s = expandNumRange(r)
  return s ? s.split(',').length : 0
}
