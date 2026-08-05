import { beforeEach, describe, expect, it } from 'vitest'
import { getHtml, syncConfig } from './helpers'
import { attributeOrder, block, rowFor } from './html'
import { seedRuns } from './seed'

/**
 * A known dataset with hand-computed metrics.
 *
 * Selected period 2026-07-20 → 2026-07-26 holds 5 successful Runs:
 *   4 on the hosting Prompt (Perplexity) and 1 on the analytics Prompt (ChatGPT).
 * The prior equivalent period, 2026-07-13 → 2026-07-19, holds 1 Run.
 */
const HOSTING = 'podcast-hosting-platforms-01'
const ANALYTICS = 'podcast-analytics-tools-01'

const FROM = '2026-07-20'
const TO = '2026-07-26'
const overview = (query = '') => getHtml(`/?from=${FROM}&to=${TO}${query}`)

beforeEach(async () => {
  await syncConfig()
  await seedRuns([
    // Prior period: Castos alone.
    { promptId: HOSTING, surface: 'perplexity', date: '2026-07-15', responseText: 'Castos only.' },

    { promptId: HOSTING, surface: 'perplexity', date: '2026-07-20', responseText: 'Castos leads, then Transistor.' },
    { promptId: HOSTING, surface: 'perplexity', date: '2026-07-21', responseText: 'Transistor is the pick.' },
    { promptId: HOSTING, surface: 'perplexity', date: '2026-07-22', responseText: 'Castos is best.' },
    { promptId: HOSTING, surface: 'perplexity', date: '2026-07-23', responseText: 'No hosts worth naming here.' },
    // A failed Run is a hole in collection, not evidence of no Mention.
    { promptId: HOSTING, surface: 'perplexity', date: '2026-07-24', error: 'Perplexity 500' },

    { promptId: ANALYTICS, surface: 'chatgpt', date: '2026-07-22', responseText: 'Buzzsprout wins, and Castos follows.' },
  ])
})

describe('overview dashboard', () => {
  it('computes Visibility, Share of Voice and average Position over the selected period', async () => {
    const html = await overview()

    // Castos: mentioned in 3 of 5 Runs; 3 of 6 Mentions; Positions 1, 1, 2.
    expect(rowFor(html, 'data-brand', 'castos')).toMatchObject({
      visibility: '60.0%',
      sov: '50.0%',
      position: '1.33',
      mentions: '3',
    })

    // Transistor: 2 of 5 Runs; 2 of 6 Mentions; Positions 2, 1.
    expect(rowFor(html, 'data-brand', 'transistor')).toMatchObject({
      visibility: '40.0%',
      sov: '33.3%',
      position: '1.50',
      mentions: '2',
    })

    // Buzzsprout: 1 of 5 Runs; 1 of 6 Mentions; Position 1.
    expect(rowFor(html, 'data-brand', 'buzzsprout')).toMatchObject({
      visibility: '20.0%',
      sov: '16.7%',
      position: '1.00',
      mentions: '1',
    })
  })

  it('shows a Brand never mentioned as zero rather than blank', async () => {
    const html = await overview()

    expect(rowFor(html, 'data-brand', 'libsyn')).toMatchObject({
      visibility: '0.0%',
      sov: '0.0%',
      position: '—',
      mentions: '0',
    })
  })

  it('ranks the leaderboard by Visibility', async () => {
    const html = await overview()
    const order = attributeOrder(html, 'data-brand')

    expect(order.slice(0, 3)).toEqual(['castos', 'transistor', 'buzzsprout'])
  })

  it('shows deltas against the prior equivalent period', async () => {
    const html = await overview()

    // Castos was in the single prior Run: Visibility 100% → 60%, Position 1.00 → 1.33.
    expect(rowFor(html, 'data-brand', 'castos')).toMatchObject({
      'visibility-delta': '-40.0pp',
      'sov-delta': '-50.0pp',
      'position-delta': '+0.33',
    })

    // Transistor had no prior Mentions, so Visibility rose and Position has no basis to compare.
    expect(rowFor(html, 'data-brand', 'transistor')).toMatchObject({
      'visibility-delta': '+40.0pp',
      'position-delta': '—',
    })
  })

  it('excludes failed Runs from the denominator', async () => {
    const html = await overview()

    // 6 Runs exist in the period but only 5 succeeded, so Castos is 3/5 not 3/6.
    expect(html).toContain('5 Runs from 2026-07-20 to 2026-07-26')
    expect(rowFor(html, 'data-brand', 'castos').visibility).toBe('60.0%')
  })

  it('applies the Surface filter to the leaderboard', async () => {
    const html = await overview('&surface=perplexity')

    // Only the 4 hosting Runs remain: Castos 2/4, Transistor 2/4, Buzzsprout none.
    expect(rowFor(html, 'data-brand', 'castos')).toMatchObject({ visibility: '50.0%', sov: '50.0%', mentions: '2' })
    expect(rowFor(html, 'data-brand', 'transistor')).toMatchObject({ visibility: '50.0%', sov: '50.0%' })
    expect(rowFor(html, 'data-brand', 'buzzsprout')).toMatchObject({ visibility: '0.0%', mentions: '0' })
  })

  it('applies the Topic filter to the leaderboard', async () => {
    const html = await overview('&topic=podcast-analytics-tools')

    // The single analytics Run mentions Buzzsprout then Castos.
    expect(html).toContain('1 Runs from')
    expect(rowFor(html, 'data-brand', 'castos')).toMatchObject({ visibility: '100.0%', sov: '50.0%', position: '2.00' })
    expect(rowFor(html, 'data-brand', 'transistor')).toMatchObject({ visibility: '0.0%', mentions: '0' })
  })

  it('plots a Visibility point per Brand per day, smoothed over the trailing window', async () => {
    const html = await overview()
    const castosSeries = block(html, 'data-series', 'castos', 'g')

    // 2026-07-20 looks back to 07-14: the 07-15 and 07-20 Runs, both mentioning Castos.
    expect(castosSeries).toContain('data-date="2026-07-20" data-visibility="1.0000"')
    // 2026-07-26 looks back to 07-20: all 5 successful Runs, 3 mentioning Castos.
    expect(castosSeries).toContain('data-date="2026-07-26" data-visibility="0.6000"')
  })

  it('offers the Topic and Surface filters on the page', async () => {
    const html = await overview()

    expect(html).toContain('Podcast hosting platforms')
    expect(html).toContain('Perplexity')
    expect(html).toContain('7-day rolling')
  })
})
