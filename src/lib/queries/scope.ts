/**
 * One definition of "the Runs these filters select", shared by every metric,
 * listing and export query. Keeping it in one place is what stops the dashboard
 * and the CSVs drifting apart when a filter is added or changed.
 */
import type { Filters } from '../filters'

export interface RunScope {
  /** A SELECT over runs yielding id, run_date and prompt_id, for use as a CTE. */
  sql: string
  params: (string | number)[]
}

export interface ScopeOptions {
  /** Defaults to the filters' own range; pass a period to compare against. */
  from?: string
  to?: string
  /** Failed Runs are holes in collection, so metrics exclude them. Listings show them. */
  includeFailed?: boolean
}

export function runScope(filters: Filters, options: ScopeOptions = {}): RunScope {
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (!options.includeFailed) conditions.push("r.status = 'ok'")

  conditions.push('r.run_date >= ?', 'r.run_date <= ?')
  params.push(options.from ?? filters.from, options.to ?? filters.to)

  if (filters.surface) {
    conditions.push('r.surface = ?')
    params.push(filters.surface)
  }
  if (filters.topicId) {
    conditions.push('p.topic_id = ?')
    params.push(filters.topicId)
  }

  return {
    sql: `SELECT r.id, r.run_date, r.prompt_id
          FROM runs r
          JOIN prompts p ON p.id = r.prompt_id
          WHERE ${conditions.join(' AND ')}`,
    params,
  }
}
