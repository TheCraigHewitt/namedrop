import { env } from 'cloudflare:workers'
import type { APIRoute } from 'astro'
import { csvResponse, domainsCsv } from '../../lib/exports'
import { parseFilters } from '../../lib/filters'

export const GET: APIRoute = async ({ url }) =>
  csvResponse(await domainsCsv(env.DB, parseFilters(url)), 'domains.csv')
