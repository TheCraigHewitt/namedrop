import { env } from 'cloudflare:workers'
import type { APIRoute } from 'astro'
import { runSweep, utcDate } from '../../lib/collection/sweep'
import { adapterFor } from '../../lib/surfaces'
import { SURFACES } from '../../lib/types'

/**
 * Re-runs collection for one Surface on one date, replacing that date's Runs.
 * Cron is the normal trigger; this is for backfilling a date the schedule lost.
 * Access control is Cloudflare Access in front of the Worker — see docs/deploy.md.
 *
 * One Surface per call, matching the cron. A fetch handler has no wall-clock
 * limit so the request simply stays open for the several minutes a sweep takes,
 * but all three Surfaces at once would strain the CPU budget a sweep runs under.
 */
export const POST: APIRoute = async ({ url }) => {
  const adapter = adapterFor(url.searchParams.get('surface') ?? '')
  if (!adapter) return json({ error: `surface must be one of: ${SURFACES.join(', ')}` }, 400)

  const date = url.searchParams.get('date') ?? utcDate()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date must be YYYY-MM-DD' }, 400)

  const resume = url.searchParams.get('resume') === 'true'

  return json(await runSweep(env, adapter, { date, resume }), 200)
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } })
