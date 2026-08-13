import { useSyncExternalStore } from 'react'

export type ChartStudyState = {
  /** 0-based trade index, or null for no selection */
  selectedTrade: number | null
}

const DEFAULT: ChartStudyState = {
  selectedTrade: null,
}

let state: ChartStudyState = { ...DEFAULT }
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function getChartStudy(): ChartStudyState {
  return state
}

export function setChartStudy(patch: Partial<ChartStudyState>) {
  state = { ...state, ...patch }
  emit()
}

export function selectTrade(index: number | null) {
  state = { ...state, selectedTrade: index }
  emit()
}

export function clearTradeFocus() {
  state = { ...state, selectedTrade: null }
  emit()
}

export function resetChartStudy() {
  state = { ...DEFAULT }
  emit()
}

export function subscribeChartStudy(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useChartStudy(): ChartStudyState {
  return useSyncExternalStore(subscribeChartStudy, getChartStudy, getChartStudy)
}
