import { env } from 'cloudflare:workers'
import type { APIRoute } from 'astro'
import { csvResponse, performanceMatrixCsv } from '../../lib/exports'
import { parseFilters } from '../../lib/filters'

export const GET: APIRoute = async ({ url }) =>
  csvResponse(await performanceMatrixCsv(env.DB, parseFilters(url)), 'performance-matrix.csv')
