import { beforeEach, describe, expect, it } from 'vitest'
import { runId } from '../src/lib/collection/sweep'
import { PROMPTS } from '../src/lib/config'
import { get, getHtml, syncConfig } from './helpers'
import { attributeOrder, block } from './html'
import { seedRuns } from './seed'

const HOSTING = 'podcast-hosting-platforms-01'
const ANALYTICS = 'podcast-analytics-tools-01'

const FROM = '2026-07-20'
const TO = '2026-07-26'
const runsPage = (query = '') => getHtml(`/runs?from=${FROM}&to=${TO}${query}`)

beforeEach(async () => {
  await syncConfig()
  await seedRuns([
    {
      promptId: HOSTING,
      surface: 'perplexity',
      date: '2026-07-20',
      responseText: 'Castos leads, then Transistor.',
      citations: ['https://castos.com/hosting/', 'https://transistor.fm/pricing/', 'https://old.reddit.com/r/podcasting/'],
      fanouts: ['best podcast hosting', 'castos vs transistor'],
    },
    {
      promptId: HOSTING,
      surface: 'chatgpt',
      date: '2026-07-21',
      responseText: 'Transistor is the pick for most shows.',
      citations: ['https://transistor.fm/'],
    },
    {
      promptId: ANALYTICS,
      surface: 'gemini',
      date: '2026-07-22',
      responseText: 'Listener location comes from IP geolocation.',
    },
    {
      promptId: ANALYTICS,
      surface: 'perplexity',
      date: '2026-07-23',
      error: 'Perplexity 503: service unavailable',
    },
  ])
})

describe('all runs list', () => {
  it('lists Runs with Surface, Prompt, mentioned Brands in order, Sources and date', async () => {
    const html = await runsPage()
    const row = block(html, 'data-run', runId('2026-07-20', 'perplexity', HOSTING))

    expect(row).toContain('2026-07-20')
    expect(row).toContain('Perplexity')
    expect(row).toContain('Show me podcast platforms with built-in ad insertion tools.')
    expect(row).toContain('Podcast hosting platforms')
    expect(row).toContain('data-sources="3"')
    // Brands appear in Position order.
    expect(row).toContain('data-brands="castos,transistor"')
    expect(row).toContain('1. Castos')
    expect(row).toContain('2. Transistor')
  })

  it('shows most recent Runs first', async () => {
    const html = await runsPage()
    const dates = attributeOrder(html, 'data-run').map((id) => id.slice(0, 10))

    expect(dates).toEqual(['2026-07-23', '2026-07-22', '2026-07-21', '2026-07-20'])
  })

  it('marks a failed Run rather than showing it as mentioning nobody', async () => {
    const html = await runsPage()
    const row = block(html, 'data-run', runId('2026-07-23', 'perplexity', ANALYTICS))

    expect(row).toContain('failed')
  })

  it('filters by mentioned Brand without hiding the other Brands in those Runs', async () => {
    const html = await runsPage('&brand=transistor')
    const ids = attributeOrder(html, 'data-run')

    expect(ids).toEqual([runId('2026-07-21', 'chatgpt', HOSTING), runId('2026-07-20', 'perplexity', HOSTING)])
    // The Castos Mention in the surviving Run is still shown.
    expect(block(html, 'data-run', runId('2026-07-20', 'perplexity', HOSTING))).toContain('data-brands="castos,transistor"')
  })

  it('filters by Surface', async () => {
    const html = await runsPage('&surface=chatgpt')

    expect(attributeOrder(html, 'data-run')).toEqual([runId('2026-07-21', 'chatgpt', HOSTING)])
  })

  it('combines the Brand and Surface filters', async () => {
    const html = await runsPage('&surface=perplexity&brand=transistor')

    expect(attributeOrder(html, 'data-run')).toEqual([runId('2026-07-20', 'perplexity', HOSTING)])
  })
})

describe('run detail', () => {
  const id = runId('2026-07-20', 'perplexity', HOSTING)

  it('renders the verbatim Response with its citations and Fanouts', async () => {
    const html = await getHtml(`/runs/${id}`)

    expect(html).toContain('Castos leads, then Transistor.')

    // Citations keep their order and show the Domain they roll up to.
    const domains = attributeOrder(html, 'data-domain')
    expect(domains).toEqual(['castos.com', 'transistor.fm', 'reddit.com'])
    expect(html).toContain('https://old.reddit.com/r/podcasting/')

    expect(html).toContain('best podcast hosting')
    expect(html).toContain('castos vs transistor')
  })

  it('lists the mentioned Brands in Position order', async () => {
    const html = await getHtml(`/runs/${id}`)

    expect(attributeOrder(html, 'data-brand')).toEqual(['castos', 'transistor'])
    expect(html).toContain('1. Castos')
    expect(html).toContain('2. Transistor')
  })

  it('says so plainly when a Surface returned no citations or Fanouts', async () => {
    const html = await getHtml(`/runs/${runId('2026-07-22', 'gemini', ANALYTICS)}`)

    expect(html).toContain('returned no citations')
    expect(html).toContain('reported no search queries')
    expect(html).toContain('No tracked Brands were mentioned.')
  })

  it('shows the error for a failed Run instead of an empty Response', async () => {
    const html = await getHtml(`/runs/${runId('2026-07-23', 'perplexity', ANALYTICS)}`)

    expect(html).toContain('Perplexity 503: service unavailable')
  })

  it('404s for a Run that does not exist', async () => {
    const response = await get('/runs/2026-07-20:perplexity:nope')

    expect(response.status).toBe(404)
  })
})

describe('a window holding more Runs than D1 allows bound parameters', () => {
  // D1 rejects a query with over 100 bound parameters, and the page loads
  // Mentions and Sources with one per Run. A single day is ~144 Runs, so the
  // page 500s on any window worth looking at — it broke as soon as real
  // collection outgrew the handful of Runs the other tests seed. The seed must
  // stay past 100 rows however small the example Prompt set gets.
  const DATES = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24']
  const SURFACES = ['chatgpt', 'gemini', 'perplexity'] as const

  beforeEach(async () => {
    await seedRuns(
      DATES.flatMap((date) =>
        SURFACES.flatMap((surface) =>
          PROMPTS.map((prompt) => ({
            promptId: prompt.id,
            surface,
            date,
            responseText: 'Castos and Transistor both rank well.',
            citations: ['https://castos.com/pricing/'],
          })),
        ),
      ),
    )
  })

  it('renders the page', async () => {
    const html = await runsPage()

    expect(html).toContain('Runs')
  })

  it('still attaches Mentions to Runs past the hundredth', async () => {
    const html = await runsPage()

    // Every seeded Run names Castos, so no row may render without its Brands.
    const rows = attributeOrder(html, 'data-run')
    expect(rows.length).toBeGreaterThan(100)
    expect(block(html, 'data-run', rows.at(-1)!)).toContain('Castos')
  })

  it('still attaches Sources to Runs past the hundredth', async () => {
    const html = await runsPage()

    const rows = attributeOrder(html, 'data-run')
    expect(block(html, 'data-run', rows.at(-1)!)).toContain('castos.com')
  })
})
