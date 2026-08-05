/** Reads of individual Runs, for browsing what the Surfaces actually said. */
import type { Filters } from '../filters'
import type { SurfaceId } from '../types'
import { runScope } from './scope'

const DEFAULT_LIMIT = 250
const MAX_LIMIT = 1000

export interface RunListItem {
  id: string
  promptId: string
  promptText: string
  topicName: string
  surface: SurfaceId
  runDate: string
  status: string
  /** Mentioned Brands in Position order. */
  brands: { id: string; name: string; position: number; isSelf: boolean }[]
  sourceCount: number
  domains: string[]
}

export interface RunDetail extends RunListItem {
  model: string | null
  error: string | null
  responseText: string | null
  sources: { ordinal: number; url: string; domain: string; title: string | null }[]
  fanouts: string[]
}

interface RunRow {
  id: string
  prompt_id: string
  prompt_text: string
  topic_name: string
  surface: SurfaceId
  run_date: string
  status: string
  model: string | null
  error: string | null
  response_text: string | null
}

/**
 * Recent Runs, optionally narrowed to those mentioning one Brand.
 *
 * The Brand filter selects Runs, then Mentions are loaded for the whole page —
 * filtering by Brand must not hide the other Brands each Run mentioned.
 */
export async function listRuns(
  db: D1Database,
  filters: Filters,
  options: { brandId?: string | null; limit?: number } = {},
): Promise<{ runs: RunListItem[]; total: number }> {
  // Browsing shows failed Runs too, so the hole in the data is visible.
  const scope = runScope(filters, { includeFailed: true })
  const brandFilter = options.brandId
    ? 'AND EXISTS (SELECT 1 FROM mentions m WHERE m.run_id = s.id AND m.brand_id = ?)'
    : ''
  const brandParams = options.brandId ? [options.brandId] : []

  // A full day is ~144 Runs, so the page must hold more than one day and say
  // plainly when it is showing only part of the match.
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

  const total = await db
    .prepare(
      `WITH scoped AS (${scope.sql})
       SELECT COUNT(*) AS total FROM scoped s WHERE 1 = 1 ${brandFilter}`,
    )
    .bind(...scope.params, ...brandParams)
    .first<{ total: number }>()

  const { results } = await db
    .prepare(
      `WITH scoped AS (${scope.sql})
       SELECT r.id, r.prompt_id, p.text AS prompt_text, t.name AS topic_name, r.surface, r.run_date, r.status
       FROM scoped s
       JOIN runs r ON r.id = s.id
       JOIN prompts p ON p.id = r.prompt_id
       JOIN topics t ON t.id = p.topic_id
       WHERE 1 = 1 ${brandFilter}
       ORDER BY r.run_date DESC, r.surface, p.id
       LIMIT ?`,
    )
    .bind(...scope.params, ...brandParams, limit)
    .all<RunRow>()

  return { runs: await decorate(db, results), total: total?.total ?? 0 }
}

/**
 * D1 rejects a query with over 100 bound parameters, and these lookups bind one
 * per Run. A single day of collection is ~144 Runs, so anything but a toy window
 * has to be read in chunks. Each Run's Mentions and Sources land wholly within
 * one chunk, so the per-Run ordering the queries establish still holds.
 */
const CHUNK = 100

/** Attaches Mentions and Sources to a page of Runs in two queries per chunk rather than per row. */
async function decorate(db: D1Database, rows: RunRow[]): Promise<RunListItem[]> {
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)
  const mentionRows: { run_id: string; brand_id: string; position: number; name: string; is_self: number }[] = []
  const sourceRows: { run_id: string; domain: string }[] = []

  for (let start = 0; start < ids.length; start += CHUNK) {
    const chunk = ids.slice(start, start + CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')

    const [mentions, sources] = await Promise.all([
      db
        .prepare(
          `SELECT m.run_id, m.brand_id, m.position, b.name, b.is_self
           FROM mentions m JOIN brands b ON b.id = m.brand_id
           WHERE m.run_id IN (${placeholders})
           ORDER BY m.position`,
        )
        .bind(...chunk)
        .all<{ run_id: string; brand_id: string; position: number; name: string; is_self: number }>(),
      db
        .prepare(`SELECT run_id, domain FROM sources WHERE run_id IN (${placeholders}) ORDER BY ordinal`)
        .bind(...chunk)
        .all<{ run_id: string; domain: string }>(),
    ])

    mentionRows.push(...mentions.results)
    sourceRows.push(...sources.results)
  }

  const brandsByRun = new Map<string, RunListItem['brands']>()
  for (const row of mentionRows) {
    const list = brandsByRun.get(row.run_id) ?? []
    list.push({ id: row.brand_id, name: row.name, position: row.position, isSelf: row.is_self === 1 })
    brandsByRun.set(row.run_id, list)
  }

  const domainsByRun = new Map<string, string[]>()
  for (const row of sourceRows) {
    domainsByRun.set(row.run_id, [...(domainsByRun.get(row.run_id) ?? []), row.domain])
  }

  return rows.map((row) => {
    const domains = domainsByRun.get(row.id) ?? []
    return {
      id: row.id,
      promptId: row.prompt_id,
      promptText: row.prompt_text,
      topicName: row.topic_name,
      surface: row.surface,
      runDate: row.run_date,
      status: row.status,
      brands: brandsByRun.get(row.id) ?? [],
      sourceCount: domains.length,
      domains: [...new Set(domains)],
    }
  })
}

export async function getRun(db: D1Database, id: string): Promise<RunDetail | null> {
  const row = await db
    .prepare(
      `SELECT r.id, r.prompt_id, p.text AS prompt_text, t.name AS topic_name, r.surface, r.run_date,
              r.status, r.model, r.error, r.response_text
       FROM runs r
       JOIN prompts p ON p.id = r.prompt_id
       JOIN topics t ON t.id = p.topic_id
       WHERE r.id = ?`,
    )
    .bind(id)
    .first<RunRow>()

  if (!row) return null

  const [base] = await decorate(db, [row])
  if (!base) return null
  const [sources, fanouts] = await Promise.all([
    db
      .prepare('SELECT ordinal, url, domain, title FROM sources WHERE run_id = ? ORDER BY ordinal')
      .bind(id)
      .all<{ ordinal: number; url: string; domain: string; title: string | null }>(),
    db.prepare('SELECT query FROM fanouts WHERE run_id = ? ORDER BY ordinal').bind(id).all<{ query: string }>(),
  ])

  return {
    ...base,
    model: row.model,
    error: row.error,
    responseText: row.response_text,
    sources: sources.results,
    fanouts: fanouts.results.map((fanout) => fanout.query),
  }
}
