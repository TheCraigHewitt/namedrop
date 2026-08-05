import { env } from 'cloudflare:workers'
import type { APIRoute } from 'astro'
import { syncConfig } from '../../lib/sync'

/**
 * Reconciles config/*.json into D1. Called after deploy and before every sweep.
 * Access control is Cloudflare Access in front of the Worker — see docs/deploy.md.
 */
export const POST: APIRoute = async () => {
  const result = await syncConfig(env.DB)
  return new Response(JSON.stringify(result, null, 2), {
    headers: { 'content-type': 'application/json' },
  })
}
