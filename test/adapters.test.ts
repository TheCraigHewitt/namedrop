import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { runId, utcDate } from '../src/lib/collection/sweep'
import { PROMPTS } from '../src/lib/config'
import cloroHosting from './fixtures/cloro/hosting-platforms.json'
import cloroNoSearch from './fixtures/cloro/no-search.json'
import geminiHosting from './fixtures/gemini/hosting-platforms.json'
import geminiNoGrounding from './fixtures/gemini/no-grounding.json'
import perplexityDefault from './fixtures/perplexity/default.json'
import { fakeProviders, promptTextOf, type FakeProviders } from './fake-providers'
import { runCron } from './helpers'

const HOSTING = 'podcast-hosting-platforms-01'
const PLAIN = 'podcast-analytics-tools-01'

const textOf = (promptId: string) => PROMPTS.find((prompt) => prompt.id === promptId)!.text

const today = utcDate()
const run = (surface: string, promptId: string) => runId(today, surface, promptId)

let providers: FakeProviders

beforeEach(() => {
  providers = fakeProviders(({ host, body }) => {
    const isHosting = promptTextOf(body) === textOf(HOSTING)
    if (host === 'api.cloro.dev') return isHosting ? cloroHosting : cloroNoSearch
    // Only the Domain classifier calls OpenAI now, and these fixtures cite
    // Brand and seeded Domains only, so no classifier call is expected.
    if (host === 'api.openai.com') return {}
    if (host === 'generativelanguage.googleapis.com') return isHosting ? geminiHosting : geminiNoGrounding
    return perplexityDefault
  })
})

const sourcesFor = async (id: string) =>
  (
    await env.DB.prepare('SELECT ordinal, url, domain, title FROM sources WHERE run_id = ? ORDER BY ordinal')
      .bind(id)
      .all<{ ordinal: number; url: string; domain: string; title: string | null }>()
  ).results

const fanoutsFor = async (id: string) =>
  (await env.DB.prepare('SELECT query FROM fanouts WHERE run_id = ? ORDER BY ordinal').bind(id).all<{ query: string }>()).results.map(
    (row) => row.query,
  )

describe('ChatGPT adapter', () => {
  it('stores the answer text, its citations, and the searches the model ran', async () => {
    await runCron()
    const id = run('chatgpt', HOSTING)

    const stored = await env.DB.prepare('SELECT status, model, response_text FROM runs WHERE id = ?')
      .bind(id)
      .first<{ status: string; model: string; response_text: string }>()
    expect(stored?.status).toBe('ok')
    // The model is whatever chatgpt.com routed the session to, not a pin of ours.
    expect(stored?.model).toBe('gpt-5-5')
    expect(stored?.response_text).toContain('Buzzsprout offers dynamic ad insertion')

    // Citations come from cloro's sources, deduplicated by URL, in order. The
    // utm_source=chatgpt.com suffix chatgpt.com appends stays on the stored URL
    // but must not leak into the Domain.
    const sources = await sourcesFor(id)
    expect(sources.map((source) => source.domain)).toEqual(['buzzsprout.com', 'captivate.fm', 'castos.com'])
    expect(sources[0]!.title).toBe('Dynamic ad insertion — Buzzsprout')

    expect(await fanoutsFor(id)).toEqual([
      'best podcast hosting platforms with dynamic ad insertion',
      'podcast hosting ad insertion comparison 2026',
    ])
  })

  it('detects Mentions in a ChatGPT answer with Position', async () => {
    await runCron()

    const mentions = (
      await env.DB.prepare('SELECT brand_id, position FROM mentions WHERE run_id = ? ORDER BY position')
        .bind(run('chatgpt', HOSTING))
        .all<{ brand_id: string; position: number }>()
    ).results
    expect(mentions.map((mention) => mention.brand_id)).toEqual(['buzzsprout', 'captivate', 'castos'])
  })

  it('stores a Run with no Sources or Fanouts when the model did not search', async () => {
    await runCron()
    const id = run('chatgpt', PLAIN)

    expect(await sourcesFor(id)).toEqual([])
    expect(await fanoutsFor(id)).toEqual([])
    const stored = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(id).first<{ status: string }>()
    expect(stored?.status).toBe('ok')
  })

  it('sends the Prompt to a US chatgpt.com session', async () => {
    await runCron()

    const call = providers.callsTo('api.cloro.dev')[0]!
    // Web search needs no toggle — cloro's ChatGPT endpoint always runs in
    // search mode, which is the product behaviour being measured.
    expect(call.body).toMatchObject({ country: 'US', include: { searchQueries: true } })
    expect(typeof (call.body as { prompt?: string }).prompt).toBe('string')
  })
})

describe('Gemini adapter', () => {
  it('joins the answer parts and reads Fanouts from grounding metadata', async () => {
    await runCron()
    const id = run('gemini', HOSTING)

    const stored = await env.DB.prepare('SELECT status, model, response_text FROM runs WHERE id = ?')
      .bind(id)
      .first<{ status: string; model: string; response_text: string }>()
    expect(stored?.status).toBe('ok')
    expect(stored?.model).toBe('gemini-2.5-flash')
    // Both content parts, concatenated.
    expect(stored?.response_text).toBe(
      'For built-in ad insertion, Podbean and Buzzsprout both include ad marketplaces. Castos supports ad insertion and is often recommended for WordPress-based shows.',
    )

    expect(await fanoutsFor(id)).toEqual([
      'podcast platforms with built-in ad insertion',
      'podcast ad marketplace hosting comparison',
    ])
  })

  it('resolves Google grounding redirects to the Domain they actually cite', async () => {
    await runCron()
    const sources = await sourcesFor(run('gemini', HOSTING))

    // Every chunk is kept as a Source, but the redirects roll up to the real
    // sites rather than all landing on google.com.
    expect(sources.map((source) => source.domain)).toEqual(['techradar.com', 'podbean.com', 'techradar.com', 'castos.com'])
    expect(sources[0]!.url).toContain('vertexaisearch.cloud.google.com')
    expect(sources[3]!.url).toBe('https://castos.com/podcast-advertising/')
  })

  it('stores a Run with no Sources or Fanouts when grounding is absent', async () => {
    await runCron()
    const id = run('gemini', PLAIN)

    expect(await sourcesFor(id)).toEqual([])
    expect(await fanoutsFor(id)).toEqual([])
    const mentions = await env.DB.prepare('SELECT brand_id FROM mentions WHERE run_id = ?')
      .bind(id)
      .all<{ brand_id: string }>()
    expect(mentions.results.map((row) => row.brand_id)).toEqual(['simplecast'])
  })

  it('sends the API key as a header and enables Google Search grounding', async () => {
    await runCron()

    const call = providers.callsTo('generativelanguage.googleapis.com')[0]!
    expect(call.url).not.toContain('key=')
    expect(call.body).toMatchObject({ tools: [{ google_search: {} }] })
  })
})

describe('surface filters', () => {
  it('offers all three Surfaces on the dashboard', async () => {
    const { getHtml } = await import('./helpers')
    const html = await getHtml('/')

    expect(html).toContain('>ChatGPT<')
    expect(html).toContain('>Perplexity<')
    expect(html).toContain('>Gemini<')
  })
})
