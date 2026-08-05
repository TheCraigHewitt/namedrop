import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import builtWorker from '../dist/server/entry.mjs'

/** Every test drives the real Worker through its own entry points. */
export const worker = exports.default

export const ORIGIN = 'http://dash.test'

export const get = (path: string): Promise<Response> => worker.fetch(new Request(`${ORIGIN}${path}`))

/** Astro's CSRF check requires a same-origin Origin header on POST. */
export const post = (path: string): Promise<Response> =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { origin: ORIGIN } }))

export const syncConfig = (): Promise<Response> => post('/api/sync-config')

export async function getHtml(path: string): Promise<string> {
  const response = await get(path)
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`)
  return response.text()
}

/**
 * The schedules the Worker collects on, one Surface each. Must match
 * `SURFACE_BY_CRON` in src/worker.ts and `triggers.crons` in wrangler.jsonc.
 */
export const COLLECTION_CRONS = ['0 7 * * *', '20 7 * * *', '40 7 * * *']

/**
 * Fires the cron entry point — the daily sweep's real trigger. The loopback
 * service binding only exposes `fetch`, so the built bundle's `scheduled`
 * export is invoked directly.
 *
 * A day's collection is three firings, one per Surface, so the default is all
 * of them. Pass `crons` to fire a single schedule.
 */
export async function runCron(date?: string, crons: string[] = COLLECTION_CRONS): Promise<void> {
  for (const cron of crons) {
    // The sweep dates Runs from the trigger time, so firing the cron for a past
    // date is how tests build history through the real entry point.
    const controller = createScheduledController({
      cron,
      ...(date ? { scheduledTime: new Date(`${date}T07:00:00Z`) } : {}),
    })
    const ctx = createExecutionContext()
    await builtWorker.scheduled!(controller, env, ctx)
    await waitOnExecutionContext(ctx)
  }
}
