// Manually re-runs collection by calling POST /api/sweep on the deployed Worker,
// one Surface at a time. Cron is the normal trigger; this backfills a date the
// schedule lost. Re-running a date replaces that date's Runs, so it is safe to
// repeat. Behind Cloudflare Access, so it authenticates with the service token.
//
//   DASHBOARD_URL=https://namedrop.your-team.workers.dev \
//   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
//     node scripts/run-sweep.mjs [--date YYYY-MM-DD] [--surface chatgpt] [--resume]
//
// --resume collects only the Prompts that have no successful Run for the date,
// for finishing a sweep that died part-way without paying for it twice.
//
// A sweep takes several minutes per Surface, and the request stays open for it.
import { Agent, setGlobalDispatcher } from 'undici'

const SURFACES = ['chatgpt', 'perplexity', 'gemini']

// Node gives up waiting for response headers after 300s, and a ChatGPT sweep
// sends none until all 48 Prompts are done — around 11 minutes. Worse, the
// Worker is killed when the client disconnects, so the default silently
// abandons a sweep mid-run: on 2026-07-31 it cost 18 of 48 Prompts and the
// money already spent on them. Nothing here should time out before the Worker
// does.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const url = process.env.DASHBOARD_URL
if (!url) {
  console.error('DASHBOARD_URL is required (and CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET behind Access).')
  process.exit(1)
}

const surface = arg('surface')
if (surface && !SURFACES.includes(surface)) {
  console.error(`--surface must be one of: ${SURFACES.join(', ')}`)
  process.exit(1)
}

const date = arg('date')
if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('--date must be YYYY-MM-DD')
  process.exit(1)
}

const headers = { origin: new URL(url).origin }
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID
  headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET
} else {
  console.warn('CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are not set — Cloudflare Access will serve its login page instead of running a sweep.')
}

/**
 * Both failure modes arrive as HTML, so the status code is what separates them.
 * Reading a 502 as an auth problem sent the 2026-07-31 re-run chasing the
 * service token when the sweep was really being cut off mid-collection.
 */
const explain = (status, contentType, body) => {
  if (status === 502 || status === 504) {
    return `Cloudflare cut the request off before the sweep finished. Runs collected so far are saved — rerun with --resume to collect the rest. A ChatGPT sweep needs longer than one request survives, so cron is its normal path.`
  }
  if (contentType.includes('html')) {
    return 'Got an HTML page, so Cloudflare Access rejected the request. Check CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET and that their policy action is Service Auth.'
  }
  return body.slice(0, 500)
}

let failed = false

// Sequentially, so the Surfaces do not compete for the Worker's CPU budget.
for (const target of surface ? [surface] : SURFACES) {
  const endpoint = new URL('/api/sweep', url)
  endpoint.searchParams.set('surface', target)
  if (date) endpoint.searchParams.set('date', date)
  if (process.argv.includes('--resume')) endpoint.searchParams.set('resume', 'true')

  const startedAt = Date.now()
  console.log(`${target}: collecting…`)

  const response = await fetch(endpoint, { method: 'POST', headers })
  const body = await response.text()
  const seconds = Math.round((Date.now() - startedAt) / 1000)

  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok || !contentType.includes('json')) {
    console.error(`${target}: FAILED after ${seconds}s — ${response.status} ${response.statusText} (${contentType})`)
    console.error(explain(response.status, contentType, body))
    failed = true
    continue
  }

  const result = JSON.parse(body)
  console.log(`${target}: ${result.ok} ok, ${result.failed} failed (${result.status}) in ${seconds}s`)
}

process.exit(failed ? 1 : 0)
