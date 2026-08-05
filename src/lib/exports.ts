/**
 * CSV exports for downstream content tooling. Column shapes mirror Peec.ai's
 * exports so research scripts written against those files port with minimal
 * change; columns Peec filled with metrics that are out of scope here
 * (sentiment, gap_score) are kept and left empty rather than dropped, so
 * header-position parsing still works.
 *
 * Every export takes the same filters as the dashboard, so exported numbers
 * match what is on screen for the same date range, Surface and Topic.
 */
import { PROMPTS, SELF_BRAND } from './config'
import { toCsv, toQuotedCsv } from './csv'
import { priorPeriod, type Filters } from './filters'
import { listTopics } from './queries/config'
import { brandMetrics, promptMetrics } from './queries/metrics'
import { runScope } from './queries/scope'
import { domainLeaderboard } from './queries/sources'
import { SURFACE_LABELS, type SurfaceId } from './types'

const rate = (value: number) => value.toFixed(4)
const percent = (value: number) => `${(value * 100).toFixed(1)}%`
const signed = (value: number | null) => (value === null ? '' : value.toFixed(4))

/** Peec's prompts export: one row per tracked Prompt with its metrics. */
export async function promptsCsv(db: D1Database, filters: Filters): Promise<string> {
  const prior = priorPeriod(filters)
  const [current, previous] = await Promise.all([
    promptMetrics(db, filters, SELF_BRAND.id),
    promptMetrics(db, { ...filters, ...prior }, SELF_BRAND.id),
  ])

  const before = new Map(previous.map((prompt) => [prompt.promptId, prompt]))
  const config = new Map(PROMPTS.map((prompt) => [prompt.id, prompt]))

  return toCsv(
    [
      'status',
      'topic_id',
      'topic_name',
      'id',
      'prompt',
      'visibility',
      'visibility_delta',
      'sentiment',
      'sentiment_delta',
      'position',
      'position_delta',
      'mentions',
      'volume',
      'branding',
      'intent',
      'tags',
      'location',
      'share_of_voice',
      'share_of_voice_delta',
      'web_search',
      'web_search_delta',
      'added_at',
    ],
    current.map((prompt) => {
      const was = before.get(prompt.promptId)
      const settings = config.get(prompt.promptId)
      // A Prompt with no Runs is unmeasured, not zero-Visibility — the table
      // shows an em dash for it, so the export leaves the cell empty to match.
      const measured = prompt.runs > 0
      const comparable = measured && was && was.runs > 0
      return [
        'active',
        prompt.topicId,
        prompt.topicName,
        prompt.promptId,
        prompt.promptText,
        measured ? rate(prompt.selfVisibility) : '',
        comparable ? signed(prompt.selfVisibility - was.selfVisibility) : '',
        // Sentiment scoring is out of scope; the columns are kept for shape.
        '',
        '',
        prompt.selfPosition === null ? '' : prompt.selfPosition.toFixed(2),
        prompt.selfPosition !== null && was?.selfPosition != null ? (prompt.selfPosition - was.selfPosition).toFixed(2) : '',
        prompt.brands.map((brand) => brand.name).join(', '),
        '',
        settings?.branding ?? '',
        settings?.intent ?? '',
        '',
        '',
        measured ? rate(prompt.selfShareOfVoice) : '',
        comparable ? signed(prompt.selfShareOfVoice - was.selfShareOfVoice) : '',
        '',
        '',
        '',
      ]
    }),
  )
}

/**
 * Peec's gap-domains export. gap_score and the citation-rate columns are Peec's
 * gap analysis, which is out of scope, so they are empty. `retrieved` is a
 * citation count here, where Peec reported a rate — see docs/exports.md.
 */
export async function domainsCsv(db: D1Database, filters: Filters): Promise<string> {
  const domains = await domainLeaderboard(db, filters, 10_000)

  return toCsv(
    ['domain', 'domain_type', 'retrieved', 'retrieval_rate', 'citation_rate', 'citation_rate_delta', 'gap_score'],
    domains.map((domain) => [domain.domain, domain.domainType, domain.retrieved, rate(domain.retrievalRate), '', '', '']),
  )
}

/** Peec's top-rankings export: Brands ordered by Visibility, one row per Surface. */
export async function topRankingsCsv(db: D1Database, filters: Filters, surfaces: SurfaceId[]): Promise<string> {
  const overall = await brandMetrics(db, filters)
  const columns = overall.map((_, index) => `#${index + 1}`)
  // Filtering to one Surface must narrow this export too, or it would disagree
  // with every other view for the same filters.
  const rowSurfaces = filters.surface ? surfaces.filter((surface) => surface === filters.surface) : surfaces

  const rows = await Promise.all(
    rowSurfaces.map(async (surface) => {
      const ranked = await brandMetrics(db, { ...filters, surface })
      return [SURFACE_LABELS[surface], ...ranked.map((brand) => brand.name)]
    }),
  )

  return toQuotedCsv([['AI models', ...columns], ...rows])
}

/**
 * Peec's performance matrix: the self Brand's Visibility by Prompt tag against Topic.
 * Rows are the branding and intent tags carried in Prompt config.
 */
export async function performanceMatrixCsv(db: D1Database, filters: Filters): Promise<string> {
  const [prompts, topics] = await Promise.all([promptMetrics(db, filters, SELF_BRAND.id), listTopics(db)])
  const config = new Map(PROMPTS.map((prompt) => [prompt.id, prompt]))

  const tags = [...new Set(PROMPTS.flatMap((prompt) => [prompt.branding, prompt.intent]).filter((tag): tag is string => !!tag))]

  const rows = tags.map((tag) => {
    const cells = topics.map((topic) => {
      const matching = prompts.filter(
        (prompt) =>
          prompt.topicId === topic.id &&
          [config.get(prompt.promptId)?.branding, config.get(prompt.promptId)?.intent].includes(tag),
      )
      const runs = matching.reduce((total, prompt) => total + prompt.runs, 0)
      const selfRuns = matching.reduce((total, prompt) => total + prompt.selfRuns, 0)
      return runs === 0 ? '' : percent(selfRuns / runs)
    })
    return [tag, ...cells]
  })

  return toQuotedCsv([['Tags', ...topics.map((topic) => topic.name)], ...rows])
}

/** Peec's query-fanouts export: what each Surface actually searched for. */
export async function fanoutsCsv(db: D1Database, filters: Filters): Promise<string> {
  const scope = runScope(filters)

  const { results } = await db
    .prepare(
      `WITH scoped AS (${scope.sql})
       SELECT r.surface, f.query, COUNT(*) AS occurrences
       FROM fanouts f
       JOIN scoped s ON s.id = f.run_id
       JOIN runs r ON r.id = s.id
       GROUP BY r.surface, f.query
       ORDER BY occurrences DESC, r.surface, f.query`,
    )
    .bind(...scope.params)
    .all<{ surface: SurfaceId; query: string; occurrences: number }>()

  return toCsv(
    ['Model', 'Query', 'Type', 'Occurrences'],
    results.map((row) => [SURFACE_LABELS[row.surface] ?? row.surface, row.query, 'search', row.occurrences]),
  )
}

export const csvResponse = (body: string, filename: string): Response =>
  new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
