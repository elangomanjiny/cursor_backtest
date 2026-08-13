import { useMemo, useState, type ReactNode } from 'react'

export type SortDir = 'asc' | 'desc'

export type SortState = {
  key: string | null
  dir: SortDir
}

function cmpValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return 0
    if (Number.isNaN(a)) return -1
    if (Number.isNaN(b)) return 1
    return a === b ? 0 : a < b ? -1 : 1
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  const sa = String(a)
  const sb = String(b)
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' })
}

export function useSortable<T>(
  rows: T[],
  getValue: (row: T, key: string) => unknown,
  initial?: SortState,
) {
  const [sort, setSort] = useState<SortState>(initial ?? { key: null, dir: 'asc' })

  const toggle = (key: string) => {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      }
      return { key, dir: 'asc' }
    })
  }

  const sorted = useMemo(() => {
    if (!sort.key) return rows
    const key = sort.key
    const mul = sort.dir === 'asc' ? 1 : -1
    const copy = rows.slice()
    copy.sort((a, b) => mul * cmpValues(getValue(a, key), getValue(b, key)))
    return copy
  }, [rows, sort.key, sort.dir, getValue])

  return { sorted, sort, toggle }
}

type SortThProps = {
  col: string
  sort: SortState
  onSort: (col: string) => void
  children: ReactNode
  title?: string
  className?: string
}

/** Clickable table header with asc/desc indicator. */
export function SortTh({ col, sort, onSort, children, title, className }: SortThProps) {
  const active = sort.key === col
  return (
    <th
      className={`sortable-th${active ? ` sorted-${sort.dir}` : ''}${className ? ` ${className}` : ''}`}
      onClick={() => onSort(col)}
      title={title ?? 'Click to sort'}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="sortable-th-inner">
        {children}
        <span className="sort-ind" aria-hidden>
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </span>
    </th>
  )
}
