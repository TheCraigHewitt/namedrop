/**
 * Which websites drive AI answers. Sources roll up to registrable Domains; a
 * Domain's retrieval count is how many times it was cited in the window, and
 * its retrieval rate is the share of Runs that cited it at least once.
 */
import type { Filters } from '../filters'
import type { DomainType } from '../types'
import { runScope } from './scope'

export interface DomainRow {
  domain: string
  domainType: DomainType
  /** Citations of this Domain in the window. */
  retrieved: number
  /** Runs citing this Domain at least once, over all Runs. */
  retrievalRate: number
  runs: number
  isSelf: boolean
}

export interface DomainTypeRow {
  domainType: DomainType
  retrieved: number
  share: number
}

const scope = (filters: Filters) => runScope(filters)

/** Domains ranked by retrieval count for the window. */
export async function domainLeaderboard(db: D1Database, filters: Filters, limit = 100): Promise<DomainRow[]> {
  const scoped = scope(filters)

  const { results } = await db
    .prepare(
      `WITH scoped AS (${scoped.sql}),
            total AS (SELECT COUNT(*) AS runs FROM scoped)
       SELECT s.domain,
              COALESCE(d.domain_type, 'Other') AS domainType,
              COUNT(*) AS retrieved,
              COUNT(DISTINCT s.run_id) AS runsCiting,
              (SELECT runs FROM total) AS runs
       FROM sources s
       JOIN scoped ON scoped.id = s.run_id
       LEFT JOIN domains d ON d.domain = s.domain
       GROUP BY s.domain, domainType
       ORDER BY retrieved DESC, s.domain
       LIMIT ?`,
    )
    .bind(...scoped.params, limit)
    .all<{ domain: string; domainType: DomainType; retrieved: number; runsCiting: number; runs: number }>()

  return results.map((row) => ({
    domain: row.domain,
    domainType: row.domainType,
    retrieved: row.retrieved,
    runs: row.runs,
    retrievalRate: row.runs === 0 ? 0 : row.runsCiting / row.runs,
    isSelf: row.domainType === 'You',
  }))
}

/** Share of citations by Domain Type, for the source-mix breakdown. */
export async function domainTypeBreakdown(db: D1Database, filters: Filters): Promise<DomainTypeRow[]> {
  const scoped = scope(filters)

  const { results } = await db
    .prepare(
      `WITH scoped AS (${scoped.sql})
       SELECT COALESCE(d.domain_type, 'Other') AS domainType, COUNT(*) AS retrieved
       FROM sources s
       JOIN scoped ON scoped.id = s.run_id
       LEFT JOIN domains d ON d.domain = s.domain
       GROUP BY domainType
       ORDER BY retrieved DESC`,
    )
    .bind(...scoped.params)
    .all<{ domainType: DomainType; retrieved: number }>()

  const total = results.reduce((sum, row) => sum + row.retrieved, 0)
  return results.map((row) => ({
    domainType: row.domainType,
    retrieved: row.retrieved,
    share: total === 0 ? 0 : row.retrieved / total,
  }))
}

/** Where our own Domain sits in the leaderboard, even if it falls outside the top slice. */
export async function selfDomainRank(db: D1Database, filters: Filters): Promise<{ domain: string; rank: number; retrieved: number } | null> {
  const scoped = scope(filters)

  const row = await db
    .prepare(
      `WITH scoped AS (${scoped.sql}),
            counts AS (
              SELECT s.domain, COUNT(*) AS retrieved
              FROM sources s
              JOIN scoped ON scoped.id = s.run_id
              GROUP BY s.domain
            ),
            ranked AS (
              SELECT domain, retrieved, RANK() OVER (ORDER BY retrieved DESC) AS rank FROM counts
            )
       SELECT ranked.domain, ranked.rank, ranked.retrieved
       FROM ranked
       JOIN domains d ON d.domain = ranked.domain
       WHERE d.domain_type = 'You'
       ORDER BY ranked.rank
       LIMIT 1`,
    )
    .bind(...scoped.params)
    .first<{ domain: string; rank: number; retrieved: number }>()

  return row ?? null
}
