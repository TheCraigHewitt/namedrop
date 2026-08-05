// Post-deploy step: reconciles config/*.json into the deployed D1 by calling
// POST /api/sync-config. Behind Cloudflare Access, so it authenticates with the
// service token. Skips with instructions rather than failing the deploy.
const url = process.env.DASHBOARD_URL
const clientId = process.env.CF_ACCESS_CLIENT_ID
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET

if (!url) {
  console.log('DASHBOARD_URL not set — skipping config sync.')
  console.log('Set DASHBOARD_URL (and CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET) then run: npm run sync')
  process.exit(0)
}

const endpoint = new URL('/api/sync-config', url)
const headers = {
  // Astro's CSRF check requires a same-origin Origin header on POST.
  origin: endpoint.origin,
}
if (clientId && clientSecret) {
  headers['CF-Access-Client-Id'] = clientId
  headers['CF-Access-Client-Secret'] = clientSecret
}

const response = await fetch(endpoint, { method: 'POST', headers })
const body = await response.text()

if (!response.ok) {
  console.error(`Config sync failed: ${response.status} ${response.statusText}`)
  console.error(body.slice(0, 500))
  process.exit(1)
}

console.log('Config synced:', body)
