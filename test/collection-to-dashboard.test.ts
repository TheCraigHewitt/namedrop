import { beforeEach, describe, expect, it } from 'vitest'
import { PROMPTS } from '../src/lib/config'
import cloroNoSearch from './fixtures/cloro/no-search.json'
import geminiNoGrounding from './fixtures/gemini/no-grounding.json'
import hostingPlatforms from './fixtures/perplexity/hosting-platforms.json'
import noBrands from './fixtures/perplexity/no-brands.json'
import { fakeProviders } from './fake-providers'
import { getHtml, runCron } from './helpers'
import { rowFor } from './html'

/**
 * The whole path, end to end: the cron collects over two days from fixture
 * provider responses, and the dashboard is read back through the request
 * handler. Nothing is seeded — every row under these assertions was written by
 * the real sweep.
 */
describe('collection through to the dashboard', () => {
  /** What Perplexity answers next; changed between sweeps to vary a day. */
  let perplexityAnswer: unknown

  beforeEach(() => {
    perplexityAnswer = hostingPlatforms
    fakeProviders(({ host }) => {
      if (host === 'api.cloro.dev') return cloroNoSearch
      if (host === 'generativelanguage.googleapis.com') return geminiNoGrounding
      if (host === 'api.openai.com') return {}
      return perplexityAnswer
    })
  })

  it('shows Visibility the cron actually collected, across two days', async () => {
    await runCron('2026-07-20')
    // Day one names Brands, day two names none, so Visibility must halve.
    perplexityAnswer = noBrands
    await runCron('2026-07-21')

    const html = await getHtml('/?from=2026-07-20&to=2026-07-21&surface=perplexity')

    // Day one: every Prompt's Response names Castos. Day two: none do.
    expect(rowFor(html, 'data-brand', 'castos')).toMatchObject({ visibility: '50.0%' })
    expect(rowFor(html, 'data-brand', 'transistor')).toMatchObject({ visibility: '50.0%' })
  })

  it('records the collected Runs against the date the cron was scheduled for', async () => {
    await runCron('2026-07-20')

    const html = await getHtml('/runs?from=2026-07-20&to=2026-07-20&surface=perplexity')

    expect(html).toContain('2026-07-20')
    // Sources collected by the sweep roll up to real Domains on the list.
    expect(html).toContain('techradar.com')
  })

  it('feeds the Sources view from collected citations', async () => {
    await runCron('2026-07-20')

    const html = await getHtml('/sources?from=2026-07-20&to=2026-07-20&surface=perplexity')

    // Both Reddit URLs in the fixture roll up to one Domain.
    expect(html).toContain('data-domain="reddit.com"')
    expect(html).toContain('data-domain="castos.com"')
  })

  it('reports every Surface as healthy once collection has run', async () => {
    await runCron()

    const html = await getHtml('/health')

    expect(html).toContain('data-health="ok"')
    expect(html).toContain(`${PROMPTS.length * 3} Runs across 3 Surfaces`)
    expect(html).toContain('data-surface-health="gemini" data-stale="false"')
  })
})
