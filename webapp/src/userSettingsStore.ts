import type { StrategyParams } from './api'
import type { FootprintMode } from './FootprintOverlay'
import type { VwapSession, VwapSource } from './computeVwap'

const KEY = 'cursor_backtest.userSettings.v1'

export type ChartUiSettings = {
  unit: 'quote' | 'base'
  showSignals: boolean
  showTrades: boolean
  showMtfLevels: boolean
  showVwap: boolean
  showFootprint: boolean
  showVaz: boolean
  showCot: boolean
  showMinMax: boolean
  showLegend: boolean
  showHoverTip: boolean
  fpMode: FootprintMode
  fpBinMult: number
  vwapSource: VwapSource
  vwapSession: VwapSession
  vwapBandsRaw: string
}

export const DEFAULT_CHART_UI: ChartUiSettings = {
  unit: 'quote',
  showSignals: true,
  showTrades: true,
  showMtfLevels: true,
  showVwap: false,
  showFootprint: false,
  showVaz: false,
  showCot: false,
  showMinMax: false,
  showLegend: false,
  showHoverTip: false,
  fpMode: 'profile',
  fpBinMult: 1,
  vwapSource: 'hlc3',
  vwapSession: 'binance',
  vwapBandsRaw: '1,2',
}

type Stored = {
  params?: Partial<StrategyParams>
  chart?: Partial<ChartUiSettings>
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Stored
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function write(next: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* quota / private mode */
  }
}

export function loadSavedParams(): Partial<StrategyParams> {
  const p = read().params
  return p && typeof p === 'object' ? p : {}
}

export function saveSavedParams(params: StrategyParams) {
  write({ ...read(), params })
}

export function loadChartUi(): ChartUiSettings {
  const merged = { ...DEFAULT_CHART_UI, ...(read().chart ?? {}) }
  if (merged.unit !== 'quote' && merged.unit !== 'base') merged.unit = 'quote'
  if (!['profile', 'bidask', 'delta', 'volume'].includes(merged.fpMode)) merged.fpMode = 'profile'
  merged.fpBinMult = Math.min(10000, Math.max(1, Math.round(Number(merged.fpBinMult) || 1)))
  return merged
}

export function saveChartUi(chart: ChartUiSettings) {
  write({ ...read(), chart })
}
