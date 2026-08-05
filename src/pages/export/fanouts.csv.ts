import { env } from 'cloudflare:workers'
import type { APIRoute } from 'astro'
import { csvResponse, fanoutsCsv } from '../../lib/exports'
import { parseFilters } from '../../lib/filters'

export const GET: APIRoute = async ({ url }) =>
  csvResponse(await fanoutsCsv(env.DB, parseFilters(url)), 'fanouts.csv')
