import { env } from 'cloudflare:workers'
import type { APIRoute } from 'astro'
import { csvResponse, topRankingsCsv } from '../../lib/exports'
import { parseFilters } from '../../lib/filters'
import { ACTIVE_SURFACES } from '../../lib/surfaces'

export const GET: APIRoute = async ({ url }) =>
  csvResponse(await topRankingsCsv(env.DB, parseFilters(url), ACTIVE_SURFACES), 'top-rankings.csv')
