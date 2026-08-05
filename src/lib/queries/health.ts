/**
 * Collection health: notice broken collection before it costs a week of data.
 *
 * Health is read from the Runs themselves, not from what a sweep row claims.
 * On 2026-07-30 the sweep was killed mid-flight and left a row saying it had
 * collected nothing while 53 Runs sat in the table — and, worse, Gemini
 * collected nothing at all and no single number showed it. Coverage is
 * therefore tracked per Surface: one Surface going dark is the alarm.
 */

import { ACTIVE_SURFACES } from '../surfaces'
import type { SurfaceId } from '../types'

/** Hours without a successful Run before a Surface is considered stale. */
export const STALE_AFTER_HOURS = 24

/** A sweep still 'running' past this was killed: Cron Triggers stop at 15 minutes. */
export const SWEEP_TRUNCATED_AFTER_MINUTES = 20

export interface FailedRun {
  id: string
  promptText: string
  surface: SurfaceId
  runDate: string
  error: string | null
}

export interface SurfaceCoverage {
  surface: SurfaceId
  /** When this Surface last collected anything. Null means it never has. */
  lastOkAt: string | null
  hoursSinceLastOk: number | null
  /** Runs on this Surface's most recent collection date. */
  okRuns: number
  failedRuns: number
  isStale: boolean
}

export interface CollectionHealth {
  surfaces: SurfaceCoverage[]
  /** Surfaces that have not collected within STALE_AFTER_HOURS. */
  staleSurfaces: SurfaceId[]
  /** Any Surface being stale is a broken state, not a degraded one. */
  isStale: boolean
  /** Totals across Surfaces, each counted on its own most recent date. */
  okRuns: number
  failedRuns: number
  /** The most recent successful Run on any Surface. */
  lastOkAt: string | null
  hoursSinceLastOk: number | null
  recentFailures: FailedRun[]
}

interface SurfaceRow {
  surface: SurfaceId
  lastOkAt: string | null
  okRuns: number
  failedRuns: number
}

export async function collectionHealth(
  db: D1Database,
  now = new Date(),
  expectedSurfaces: SurfaceId[] = ACTIVE_SURFACES,
): Promise<CollectionHealth> {
  // Counts come from each Surface's own most recent collection date, so a
  // Surface that stopped days ago still reports the day it last managed.
  const { results: rows } = await db
    .prepare(
      `SELECT r.surface,
              MAX(CASE WHEN r.status = 'ok' THEN r.created_at END) AS lastOkAt,
              SUM(CASE WHEN r.status = 'ok' AND r.run_date = latest.run_date THEN 1 ELSE 0 END) AS okRuns,
              SUM(CASE WHEN r.status = 'failed' AND r.run_date = latest.run_date THEN 1 ELSE 0 END) AS failedRuns
       FROM runs r
       JOIN (SELECT surface, MAX(run_date) AS run_date FROM runs GROUP BY surface) latest
         ON latest.surface = r.surface
       GROUP BY r.surface`,
    )
    .all<SurfaceRow>()

  const bySurface = new Map(rows.map((row) => [row.surface, row]))

  const surfaces: SurfaceCoverage[] = expectedSurfaces.map((surface) => {
    const row = bySurface.get(surface)
    const hoursSinceLastOk = row?.lastOkAt ? hoursBetween(row.lastOkAt, now) : null
    return {
      surface,
      lastOkAt: row?.lastOkAt ?? null,
      hoursSinceLastOk,
      okRuns: row?.okRuns ?? 0,
      failedRuns: row?.failedRuns ?? 0,
      // Never having collected is stale too — that is exactly the state to notice.
      isStale: hoursSinceLastOk === null || hoursSinceLastOk >= STALE_AFTER_HOURS,
    }
  })

  const { results: recentFailures } = await db
    .prepare(
      `SELECT r.id, p.text AS promptText, r.surface, r.run_date AS runDate, r.error
       FROM runs r
       JOIN prompts p ON p.id = r.prompt_id
       WHERE r.status = 'failed' AND r.run_date >= ?
       ORDER BY r.run_date DESC, r.surface
       LIMIT 50`,
    )
    .bind(isoDate(addHours(now, -7 * 24)))
    .all<FailedRun>()

  const lastOkAt = surfaces
    .map((coverage) => coverage.lastOkAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1)

  return {
    surfaces,
    staleSurfaces: surfaces.filter((coverage) => coverage.isStale).map((coverage) => coverage.surface),
    isStale: surfaces.some((coverage) => coverage.isStale),
    okRuns: surfaces.reduce((total, coverage) => total + coverage.okRuns, 0),
    failedRuns: surfaces.reduce((total, coverage) => total + coverage.failedRuns, 0),
    lastOkAt: lastOkAt ?? null,
    hoursSinceLastOk: lastOkAt ? hoursBetween(lastOkAt, now) : null,
    recentFailures,
  }
}

/**
 * What a sweep row actually says happened. A row left 'running' long after the
 * Cron Trigger cap was killed part-way, and reporting that as still in flight
 * hides the truncation that lost the rest of the day.
 */
export function sweepStatus(sweep: { started_at: string; completed_at: string | null; status: string }, now = new Date()): string {
  if (sweep.completed_at) return sweep.status
  const minutesRunning = (now.getTime() - Date.parse(sweep.started_at)) / 60_000
  return minutesRunning > SWEEP_TRUNCATED_AFTER_MINUTES ? 'truncated' : 'running'
}

const hoursBetween = (at: string, now: Date) => (now.getTime() - Date.parse(at)) / 3_600_000
const addHours = (at: Date, hours: number) => new Date(at.getTime() + hours * 3_600_000)
const isoDate = (at: Date) => at.toISOString().slice(0, 10)
