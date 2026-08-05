import { beforeEach, describe, expect, it } from 'vitest'
import { PROMPTS } from '../src/lib/config'
import { getHtml, syncConfig } from './helpers'
import { attributeOrder, rowFor } from './html'
import { seedRuns } from './seed'

/**
 * Three Prompts with deliberately different Castos standing:
 *   STRONG   — Castos named first in both Runs
 *   WEAK     — Castos named last in one of two Runs
 *   INVISIBLE — Castos never mentioned
 */
const STRONG = 'podcast-hosting-platforms-01'
const WEAK = 'podcast-hosting-platforms-02'
const INVISIBLE = 'podcast-analytics-tools-01'

const FROM = '2026-07-20'
const TO = '2026-07-26'
const promptsPage = (query = '') => getHtml(`/prompts?from=${FROM}&to=${TO}${query}`)

beforeEach(async () => {
  await syncConfig()
  await seedRuns([
    { promptId: STRONG, surface: 'perplexity', date: '2026-07-20', responseText: 'Castos leads, then Transistor.' },
    { promptId: STRONG, surface: 'chatgpt', date: '2026-07-20', responseText: 'Castos is the best pick.' },

    { promptId: WEAK, surface: 'perplexity', date: '2026-07-21', responseText: 'Transistor and Buzzsprout, then Castos.' },
    { promptId: WEAK, surface: 'chatgpt', date: '2026-07-21', responseText: 'Transistor is the pick.' },

    { promptId: INVISIBLE, surface: 'perplexity', date: '2026-07-22', responseText: 'Buzzsprout and Libsyn both work.' },
  ])
})

describe('prompts table', () => {
  it('shows per-Prompt Visibility, Position, Share of Voice and mentioned Brands', async () => {
    const html = await promptsPage()

    // Castos in both Runs, first each time; 2 of 3 Mentions.
    expect(rowFor(html, 'data-prompt', STRONG)).toMatchObject({
      visibility: '100.0%',
      position: '1.00',
      sov: '66.7%',
      runs: '2',
    })

    // Castos in 1 of 2 Runs, third that time; 1 of 4 Mentions.
    expect(rowFor(html, 'data-prompt', WEAK)).toMatchObject({
      visibility: '50.0%',
      position: '3.00',
      sov: '25.0%',
      runs: '2',
    })

    expect(rowFor(html, 'data-prompt', INVISIBLE)).toMatchObject({
      visibility: '0.0%',
      position: '—',
      sov: '0.0%',
      runs: '1',
    })
  })

  it('lists every Brand mentioned for a Prompt', async () => {
    const html = await promptsPage()
    const brands = rowFor(html, 'data-prompt', WEAK).brands

    expect(brands).toContain('Transistor')
    expect(brands).toContain('Buzzsprout')
    expect(brands).toContain('Castos')
  })

  it('defaults to Castos Visibility ascending — the content-targeting view', async () => {
    const html = await promptsPage()
    const order = attributeOrder(html, 'data-prompt')

    // Prompts with no Runs share 0% and sort alongside the invisible one; what
    // matters is that the weakest come first and the strongest last.
    expect(order.indexOf(INVISIBLE)).toBeLessThan(order.indexOf(WEAK))
    expect(order.indexOf(WEAK)).toBeLessThan(order.indexOf(STRONG))
    expect(order.at(-1)).toBe(STRONG)
  })

  it('sorts the other direction on request', async () => {
    const html = await promptsPage('&sort=visibility&dir=desc')
    const order = attributeOrder(html, 'data-prompt')

    expect(order[0]).toBe(STRONG)
    expect(order.indexOf(STRONG)).toBeLessThan(order.indexOf(WEAK))
  })

  it('sorts by average Position, keeping unmentioned Prompts last', async () => {
    const html = await promptsPage('&sort=position&dir=asc')
    const order = attributeOrder(html, 'data-prompt')

    expect(order.indexOf(STRONG)).toBeLessThan(order.indexOf(WEAK))
    expect(order.indexOf(WEAK)).toBeLessThan(order.indexOf(INVISIBLE))
  })

  it('lists every active Prompt, including those with no Runs yet', async () => {
    const html = await promptsPage()

    expect(attributeOrder(html, 'data-prompt')).toHaveLength(PROMPTS.length)
    expect(rowFor(html, 'data-prompt', 'podcast-monetization-01')).toMatchObject({ runs: '0', visibility: '—' })
  })

  it('filters by Topic', async () => {
    const html = await promptsPage('&topic=podcast-analytics-tools')
    const order = attributeOrder(html, 'data-prompt')

    expect(order).toContain(INVISIBLE)
    expect(order).not.toContain(STRONG)
  })

  it('applies the Surface filter to the metrics', async () => {
    const html = await promptsPage('&surface=chatgpt')

    // Only the ChatGPT Run remains for the weak Prompt, and Castos is absent from it.
    expect(rowFor(html, 'data-prompt', WEAK)).toMatchObject({ visibility: '0.0%', runs: '1' })
    expect(rowFor(html, 'data-prompt', STRONG)).toMatchObject({ visibility: '100.0%', runs: '1' })
  })
})
