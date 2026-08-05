/**
 * The single Worker: Astro serves the dashboard and exports over `fetch`, and
 * the daily collection sweep runs on `scheduled`.
 */
import { handle } from '@astrojs/cloudflare/handler'
import { runSweep, utcDate } from './lib/collection/sweep'
import { adapterFor } from './lib/surfaces'
import { syncConfig } from './lib/sync'

/**
 * One Surface per schedule, so each gets its own 15-minute Cron Trigger budget.
 * Spaced wider than that cap, so two sweeps can never overlap and compete for
 * the same provider's rate limit. Must stay in step with `triggers.crons` in
 * wrangler.jsonc — a schedule with no Surface here collects nothing.
 */
const SURFACE_BY_CRON: Record<string, string> = {
  '0 7 * * *': 'chatgpt',
  '20 7 * * *': 'perplexity',
  '40 7 * * *': 'gemini',
}

export default {
  fetch: handle,

  async scheduled(controller, env, _ctx) {
    // Config is the source of truth for what we track, so reconcile before
    // collecting; a deploy that changed Prompts takes effect on the next sweep.
    await syncConfig(env.DB)

    if (env.COLLECTION_ENABLED !== 'true') return

    const adapter = adapterFor(SURFACE_BY_CRON[controller.cron] ?? '')
    if (!adapter) {
      console.error(`Cron "${controller.cron}" maps to no Surface — nothing collected.`)
      return
    }

    // The Run date comes from the trigger, not the clock, so a late or replayed
    // firing still records the day it was scheduled for.
    const result = await runSweep(env, adapter, { date: utcDate(new Date(controller.scheduledTime)) })
    console.log(`Sweep ${result.sweepId}: ${result.ok} ok, ${result.failed} failed (${result.status})`)
  },
} satisfies ExportedHandler<Cloudflare.Env>
