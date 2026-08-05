import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { utcDate } from '../src/lib/collection/sweep'
import { SURFACES, type SurfaceId } from '../src/lib/types'
import { getHtml, syncConfig } from './helpers'
import { block } from './html'
import { seedRuns } from './seed'

const ANALYTICS = 'podcast-analytics-tools-01'
const HOSTING = 'podcast-hosting-platforms-01'

const today = utcDate()
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

/** One collected Run per Surface — the shape of a day that worked. */
const collected = (surfaces: SurfaceId[], date: string, createdAt?: string) =>
  surfaces.map((surface) => ({
    promptId: HOSTING,
    surface,
    date,
    responseText: 'Castos and Buzzsprout are both solid choices.',
    ...(createdAt ? { createdAt } : {}),
  }))

beforeEach(async () => {
  await syncConfig()
})

describe('collection health', () => {
  it('reports healthy when every Surface collected today', async () => {
    await seedRuns(collected([...SURFACES], today, hoursAgo(2)))

    const html = await getHtml('/health')

    expect(html).toContain('data-health="ok"')
    expect(html).toContain('3 Runs across 3 Surfaces')
  })

  it('names the Surface that has never collected, rather than just looking sparse', async () => {
    // The 2026-07-30 failure: two Surfaces collected, Gemini never started, and
    // no number on the dashboard said so.
    await seedRuns(collected(['chatgpt', 'perplexity'], today, hoursAgo(2)))

    const html = await getHtml('/health')

    expect(html).toContain('data-health="stale"')
    expect(html).toContain('no Runs from Gemini')

    const gemini = block(html, 'data-surface-health', 'gemini')
    expect(gemini).toContain('never')
  })

  it('goes stale for a Surface that stopped collecting, while the others still run', async () => {
    await seedRuns([...collected(['chatgpt', 'perplexity'], today, hoursAgo(2)), ...collected(['gemini'], daysAgo(3))])

    const html = await getHtml('/health')

    expect(html).toContain('data-health="stale"')
    expect(html).toContain('no Runs from Gemini')
    // `block` reads inner HTML, so the row's own attributes are matched here.
    expect(html).toContain('data-surface-health="gemini" data-stale="true"')
    expect(html).toContain('data-surface-health="chatgpt" data-stale="false"')
  })

  it('treats never having collected at all as stale', async () => {
    const html = await getHtml('/health')

    expect(html).toContain('data-health="stale"')
    for (const surface of SURFACES) {
      expect(block(html, 'data-surface-health', surface)).toContain('never')
    }
  })

  it('is degraded rather than stale when every Surface collected but some Runs failed', async () => {
    await seedRuns([
      ...collected([...SURFACES], today, hoursAgo(2)),
      { promptId: ANALYTICS, surface: 'gemini', date: today, error: 'Gemini 429: rate limited' },
    ])

    const html = await getHtml('/health')

    expect(html).toContain('data-health="degraded"')

    const failure = block(html, 'data-failure', `${today}:gemini:${ANALYTICS}`)
    expect(failure).toContain('Gemini')
    expect(failure).toContain('How can I see where my podcast listeners are located?')
    expect(failure).toContain('Gemini 429: rate limited')
  })

  it('says so plainly when there are no failed Runs', async () => {
    await seedRuns(collected([...SURFACES], today, hoursAgo(2)))

    const html = await getHtml('/health')

    expect(html).toContain('data-failures="0"')
  })

  it('shows a sweep killed at the Cron Trigger cap as truncated, not still running', async () => {
    await env.DB.prepare(
      "INSERT INTO sweeps (id, started_at, completed_at, status, ok_count, failed_count, surface) VALUES (?, ?, NULL, 'running', 30, 0, 'chatgpt')",
    )
      .bind('sweep-cut-short', hoursAgo(3))
      .run()

    const sweep = block(await getHtml('/health'), 'data-sweep', 'sweep-cut-short')

    // Counts are written as Runs land, so a truncated sweep still reports them.
    expect(sweep).toContain('truncated')
    expect(sweep).toContain('30')
  })

  it('surfaces the health state on the Overview so a stale state is unmissable', async () => {
    const html = await getHtml('/')

    expect(html).toContain('data-health="stale"')
    expect(html).toContain('Collection is stale')
  })
})
