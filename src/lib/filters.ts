/** Date range, Surface and Topic filters, shared by every view and every export. */
import { SURFACES, type SurfaceId } from './types'

/** Rolling window for smoothing the Visibility trend, in days. */
export const DEFAULT_WINDOW = 7
export const DEFAULT_RANGE_DAYS = 30

export interface Filters {
  /** Inclusive, YYYY-MM-DD. */
  from: string
  to: string
  surface: SurfaceId | null
  topicId: string | null
  window: number
}

export const addDays = (date: string, days: number): string => {
  const at = new Date(`${date}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1

/**
 * Query strings are untrusted. The shape check alone is not enough — "2026-13-45"
 * matches it but makes an Invalid Date, and "2026-02-30" silently rolls over to
 * March — so the value must survive a round trip to count as a date.
 */
const isDate = (value: string | null): value is string => {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const at = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value
}

export function parseFilters(url: URL, today = new Date().toISOString().slice(0, 10)): Filters {
  const params = url.searchParams
  const to = isDate(params.get('to')) ? params.get('to')! : today
  const from = isDate(params.get('from')) ? params.get('from')! : addDays(to, -(DEFAULT_RANGE_DAYS - 1))

  const surface = params.get('surface')
  const topicId = params.get('topic')
  const window = Number(params.get('window'))

  return {
    from: from <= to ? from : to,
    to,
    surface: SURFACES.includes(surface as SurfaceId) ? (surface as SurfaceId) : null,
    topicId: topicId && topicId !== '' ? topicId : null,
    window: Number.isInteger(window) && window > 0 ? window : DEFAULT_WINDOW,
  }
}

/** The period of equal length immediately before the selected one. */
export function priorPeriod(filters: Filters): { from: string; to: string } {
  const length = daysBetween(filters.from, filters.to)
  return { from: addDays(filters.from, -length), to: addDays(filters.from, -1) }
}

/** Rebuilds the query string, so a filter control can change one value and keep the rest. */
export function filterQuery(filters: Filters, overrides: Partial<Record<'from' | 'to' | 'surface' | 'topic', string | null>> = {}): string {
  const params = new URLSearchParams()
  const values = {
    from: filters.from,
    to: filters.to,
    surface: filters.surface,
    topic: filters.topicId,
    ...overrides,
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== '') params.set(key, value)
  }
  return `?${params.toString()}`
}
