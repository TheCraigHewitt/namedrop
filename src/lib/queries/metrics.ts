/**
 * Metrics are computed by SQL aggregation over Runs at read time — the Run,
 * Mention and Source rows are the source of truth, with no denormalized metric
 * tables. Definitions come from CONTEXT.md:
 *
 *   Visibility = Runs in the window whose Response mentions the Brand ÷ all Runs
 *   Share of Voice = the Brand's Mentions ÷ all tracked Brands' Mentions
 *   Position = mean Position over the Runs where the Brand appeared
 *
 * Only successful Runs count; a failed Run is a hole in collection, not evidence
 * that nobody was mentioned.
 */
import { addDays, type Filters } from '../filters'
import { runScope } from './scope'

export interface BrandMetrics {
  brandId: string
  name: string
  isSelf: boolean
  /** Number of Runs whose Response mentioned this Brand. */
  mentions: number
  visibility: number
  shareOfVoice: number
  /** Null when the Brand was never mentioned in the window. */
  position: number | null
}

export interface BrandMetricsWithDelta extends BrandMetrics {
  visibilityDelta: number | null
  shareOfVoiceDelta: number | null
  positionDelta: number | null
}

export interface TrendPoint {
  date: string
  brandId: string
  visibility: number
  runs: number
}

const scopedRuns = (filters: Filters, from: string, to: string) => runScope(filters, { from, to })

/** Visibility, Share of Voice and average Position per Brand for one period. */
export async function brandMetrics(db: D1Database, filters: Filters, period = filters): Promise<BrandMetrics[]> {
  const scope = scopedRuns(filters, period.from, period.to)

  const { results } = await db
    .prepare(
      `WITH scoped AS (${scope.sql}),
            per_brand AS (
              SELECT m.brand_id,
                     COUNT(*) AS mentions,
                     AVG(m.position) AS position
              FROM mentions m
              JOIN scoped s ON s.id = m.run_id
              -- Share of Voice is over *tracked* Brands, so a deactivated Brand
              -- must leave the denominator or the shares stop summing to 1.
              JOIN brands ab ON ab.id = m.brand_id AND ab.active = 1
              GROUP BY m.brand_id
            )
       SELECT b.id AS brandId,
              b.name,
              b.is_self AS isSelf,
              COALESCE(pb.mentions, 0) AS mentions,
              COALESCE(pb.mentions, 0) * 1.0 / NULLIF((SELECT COUNT(*) FROM scoped), 0) AS visibility,
              COALESCE(pb.mentions, 0) * 1.0 / NULLIF((SELECT SUM(mentions) FROM per_brand), 0) AS shareOfVoice,
              pb.position AS position
       FROM brands b
       LEFT JOIN per_brand pb ON pb.brand_id = b.id
       WHERE b.active = 1
       ORDER BY visibility DESC, b.name`,
    )
    .bind(...scope.params)
    .all<{
      brandId: string
      name: string
      isSelf: number
      mentions: number
      visibility: number | null
      shareOfVoice: number | null
      position: number | null
    }>()

  return results.map((row) => ({
    brandId: row.brandId,
    name: row.name,
    isSelf: row.isSelf === 1,
    mentions: row.mentions,
    visibility: row.visibility ?? 0,
    shareOfVoice: row.shareOfVoice ?? 0,
    position: row.position,
  }))
}

/** The leaderboard: current-period metrics with deltas against the prior equivalent period. */
export async function brandLeaderboard(
  db: D1Database,
  filters: Filters,
  prior: { from: string; to: string },
): Promise<BrandMetricsWithDelta[]> {
  const priorFilters = { ...filters, ...prior }
  const [current, previous, priorRuns] = await Promise.all([
    brandMetrics(db, filters),
    brandMetrics(db, filters, priorFilters),
    runCount(db, priorFilters),
  ])

  const before = new Map(previous.map((metrics) => [metrics.brandId, metrics]))
  // A prior period that collected Runs but produced no Mentions is real data:
  // a Brand going from 0% to 40% deserves a delta, not a dash.
  const hadPriorRuns = priorRuns > 0

  return current.map((metrics) => {
    const was = before.get(metrics.brandId)
    return {
      ...metrics,
      // No prior data means no delta, which is different from a delta of zero.
      visibilityDelta: hadPriorRuns && was ? metrics.visibility - was.visibility : null,
      shareOfVoiceDelta: hadPriorRuns && was ? metrics.shareOfVoice - was.shareOfVoice : null,
      positionDelta: metrics.position !== null && was?.position != null ? metrics.position - was.position : null,
    }
  })
}

/**
 * Visibility per Brand per day, each point smoothed over the trailing
 * `filters.window` days so day-to-day noise does not hide the trend.
 */
export async function visibilityTrend(db: D1Database, filters: Filters): Promise<TrendPoint[]> {
  // Points at the start of the range still need a full window behind them.
  const scope = scopedRuns(filters, addDays(filters.from, -(filters.window - 1)), filters.to)

  const { results } = await db
    .prepare(
      `WITH RECURSIVE dates(d) AS (
              SELECT ?
              UNION ALL
              SELECT date(d, '+1 day') FROM dates WHERE d < ?
            ),
            scoped AS (${scope.sql})
       SELECT dates.d AS date,
              b.id AS brandId,
              (SELECT COUNT(*) FROM scoped s
                WHERE s.run_date > date(dates.d, ?) AND s.run_date <= dates.d) AS runs,
              (SELECT COUNT(*) FROM mentions m
                JOIN scoped s ON s.id = m.run_id
                WHERE m.brand_id = b.id AND s.run_date > date(dates.d, ?) AND s.run_date <= dates.d) AS mentionRuns
       FROM dates
       CROSS JOIN brands b
       WHERE b.active = 1
       ORDER BY dates.d, b.name`,
    )
    .bind(filters.from, filters.to, ...scope.params, `-${filters.window} days`, `-${filters.window} days`)
    .all<{ date: string; brandId: string; runs: number; mentionRuns: number }>()

  return results.map((row) => ({
    date: row.date,
    brandId: row.brandId,
    runs: row.runs,
    visibility: row.runs === 0 ? 0 : row.mentionRuns / row.runs,
  }))
}

export interface PromptMetrics {
  promptId: string
  promptText: string
  topicId: string
  topicName: string
  runs: number
  /** Runs mentioning our own Brand, kept alongside the rate so groups can re-aggregate. */
  selfRuns: number
  /** Visibility of our own Brand for this Prompt — the content-targeting number. */
  selfVisibility: number
  /** Average Position of our own Brand, over Runs where it appeared. */
  selfPosition: number | null
  selfShareOfVoice: number
  /** Every Brand mentioned for this Prompt, most visible first. */
  brands: { id: string; name: string; isSelf: boolean; mentions: number }[]
}

/**
 * Per-Prompt metrics for content targeting, using the same definitions as the
 * Brand leaderboard but with each Prompt as the population of Runs.
 */
export async function promptMetrics(db: D1Database, filters: Filters, selfBrandId: string): Promise<PromptMetrics[]> {
  const scope = scopedRuns(filters, filters.from, filters.to)

  const [rows, brandRows] = await Promise.all([
    db
      .prepare(
        `WITH scoped AS (${scope.sql})
         SELECT p.id AS promptId,
                p.text AS promptText,
                p.topic_id AS topicId,
                t.name AS topicName,
                COUNT(DISTINCT s.id) AS runs,
                COUNT(DISTINCT CASE WHEN m.brand_id = ? THEN s.id END) AS selfRuns,
                AVG(CASE WHEN m.brand_id = ? THEN m.position END) AS selfPosition,
                COUNT(m.brand_id) AS totalMentions,
                COUNT(CASE WHEN m.brand_id = ? THEN 1 END) AS selfMentions
         FROM prompts p
         JOIN topics t ON t.id = p.topic_id
         LEFT JOIN scoped s ON s.prompt_id = p.id
         LEFT JOIN mentions m ON m.run_id = s.id
         WHERE p.active = 1${filters.topicId ? ' AND p.topic_id = ?' : ''}
         GROUP BY p.id
         ORDER BY t.name, p.id`,
      )
      .bind(...scope.params, selfBrandId, selfBrandId, selfBrandId, ...(filters.topicId ? [filters.topicId] : []))
      .all<{
        promptId: string
        promptText: string
        topicId: string
        topicName: string
        runs: number
        selfRuns: number
        selfPosition: number | null
        totalMentions: number
        selfMentions: number
      }>(),
    db
      .prepare(
        `WITH scoped AS (${scope.sql})
         SELECT s.prompt_id AS promptId, b.id AS brandId, b.name, b.is_self AS isSelf, COUNT(*) AS mentions
         FROM mentions m
         JOIN scoped s ON s.id = m.run_id
         JOIN brands b ON b.id = m.brand_id
         GROUP BY s.prompt_id, b.id
         ORDER BY mentions DESC, b.name`,
      )
      .bind(...scope.params)
      .all<{ promptId: string; brandId: string; name: string; isSelf: number; mentions: number }>(),
  ])

  const brandsByPrompt = new Map<string, PromptMetrics['brands']>()
  for (const row of brandRows.results) {
    const list = brandsByPrompt.get(row.promptId) ?? []
    list.push({ id: row.brandId, name: row.name, isSelf: row.isSelf === 1, mentions: row.mentions })
    brandsByPrompt.set(row.promptId, list)
  }

  return rows.results.map((row) => ({
    promptId: row.promptId,
    promptText: row.promptText,
    topicId: row.topicId,
    topicName: row.topicName,
    runs: row.runs,
    selfRuns: row.selfRuns,
    selfVisibility: row.runs === 0 ? 0 : row.selfRuns / row.runs,
    selfPosition: row.selfPosition,
    selfShareOfVoice: row.totalMentions === 0 ? 0 : row.selfMentions / row.totalMentions,
    brands: brandsByPrompt.get(row.promptId) ?? [],
  }))
}

/** Total successful Runs in the selected period, for context on how solid the metrics are. */
export async function runCount(db: D1Database, filters: Filters): Promise<number> {
  const scope = scopedRuns(filters, filters.from, filters.to)
  const row = await db
    .prepare(`WITH scoped AS (${scope.sql}) SELECT COUNT(*) AS total FROM scoped`)
    .bind(...scope.params)
    .first<{ total: number }>()
  return row?.total ?? 0
}
