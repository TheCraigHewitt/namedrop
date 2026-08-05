import { env } from 'cloudflare:workers'
import type { APIRoute } from 'astro'
import { csvResponse, promptsCsv } from '../../lib/exports'
import { parseFilters } from '../../lib/filters'

export const GET: APIRoute = async ({ url }) =>
  csvResponse(await promptsCsv(env.DB, parseFilters(url)), 'prompts.csv')
