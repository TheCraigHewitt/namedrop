import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { getHtml, runCron, syncConfig } from './helpers'
import { attributeOrder, block } from './html'
import { seedRuns } from './seed'
import { fakeProviders, promptTextOf, type FakeProviders } from './fake-providers'
import { PROMPTS } from '../src/lib/config'
import { classifyNewDomains } from '../src/lib/domains/classify'
import geminiNoGrounding from './fixtures/gemini/no-grounding.json'
import newDomain from './fixtures/perplexity/new-domain.json'
import cloroNoSearch from './fixtures/cloro/no-search.json'
import openaiNoSearch from './fixtures/openai/no-search.json'

const HOSTING = 'podcast-hosting-platforms-01'
const ANALYTICS = 'podcast-analytics-tools-01'
const UNSEEN = 'podcastgearreview.test'
/** Cited by a Run a truncated sweep stored but never classified. */
const ORPHANED = 'leftoverforum.test'

const textOf = (promptId: string) => PROMPTS.find((prompt) => prompt.id === promptId)!.text

/** Classification calls the Responses API too, distinguished by its model. */
const isClassifierCall = (body: unknown) => (body as { model?: string })?.model === 'gpt-5-nano'

const classifierReply = (types: Record<string, string>) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(types) }] }],
})

describe('Domain Type classification', () => {
  let providers: FakeProviders

  const sweepCiting = async (classification: unknown) => {
    providers = fakeProviders(({ host, body }) => {
      if (host === 'api.cloro.dev') return cloroNoSearch
      if (host === 'api.openai.com') return isClassifierCall(body) ? classification : openaiNoSearch
      if (host === 'generativelanguage.googleapis.com') return geminiNoGrounding
      // Only one Prompt cites the unseen Domain, keeping the classifier call countable.
      return promptTextOf(body) === textOf(HOSTING) ? newDomain : { body: { choices: [{ message: { content: 'No hosts named.' } }] } }
    })
    await runCron()
  }

  const domainRow = (domain: string) =>
    env.DB.prepare('SELECT domain_type, classified_by FROM domains WHERE domain = ?')
      .bind(domain)
      .first<{ domain_type: string; classified_by: string }>()

  it('takes the Domain Type from the seed map first', async () => {
    await sweepCiting(classifierReply({ [UNSEEN]: 'Editorial' }))

    expect(await domainRow('techradar.com')).toEqual({ domain_type: 'Editorial', classified_by: 'seed' })
  })

  it('derives You from Brand config for our own Domain', async () => {
    await sweepCiting(classifierReply({ [UNSEEN]: 'Editorial' }))

    // castos.com is deliberately absent from Peec's gap export, so Brand config decides.
    expect(await domainRow('castos.com')).toEqual({ domain_type: 'You', classified_by: 'brand' })
  })

  it('classifies an unseen Domain with one LLM call and stores the result', async () => {
    await sweepCiting(classifierReply({ [UNSEEN]: 'Editorial' }))

    expect(await domainRow(UNSEEN)).toEqual({ domain_type: 'Editorial', classified_by: 'llm' })

    const classifierCalls = providers.callsTo('api.openai.com').filter((call) => isClassifierCall(call.body))
    expect(classifierCalls).toHaveLength(1)
    // Seeded and Brand-derived Domains never reach the model.
    expect(JSON.stringify(classifierCalls[0]!.body)).toContain(UNSEEN)
    expect(JSON.stringify(classifierCalls[0]!.body)).not.toContain('techradar.com')
  })

  it('leaves a Domain unclassified when the classifier is down, without losing the Run', async () => {
    await sweepCiting({ status: 500, body: { error: 'classifier down' } })

    // A Domain Type is assigned once and then fixed, so recording Other here
    // would freeze a transient outage into the data permanently.
    expect(await domainRow(UNSEEN)).toBeNull()

    const sources = await env.DB.prepare('SELECT COUNT(*) AS total FROM sources WHERE domain = ?')
      .bind(UNSEEN)
      .first<{ total: number }>()
    expect(sources?.total).toBe(1)
  })

  it('still classifies the Domains it can when the classifier is down', async () => {
    await sweepCiting({ status: 500, body: { error: 'classifier down' } })

    // Seed and Brand assignments need no model, so an outage must not lose them.
    expect(await domainRow('techradar.com')).toEqual({ domain_type: 'Editorial', classified_by: 'seed' })
    expect(await domainRow('castos.com')).toEqual({ domain_type: 'You', classified_by: 'brand' })
  })

  it('falls back to Other for a Domain the classifier answered without', async () => {
    // The call succeeded, so its silence about UNSEEN is a judgement, not an outage.
    await sweepCiting(classifierReply({ 'someotherdomain.test': 'Editorial' }))

    expect(await domainRow(UNSEEN)).toEqual({ domain_type: 'Other', classified_by: 'fallback' })
  })

  it('classifies Domains a truncated sweep left behind', async () => {
    await syncConfig()
    // A sweep killed at the Cron Trigger's 15-minute cap stores its Runs but
    // never reaches classification, so its Domains have no Domain Type. The
    // next sweep is what repairs that.
    await env.DB.prepare(
      `INSERT INTO runs (id, prompt_id, surface, run_date, created_at, status)
       VALUES ('2026-07-29:chatgpt:cut', ?, 'chatgpt', '2026-07-29', '2026-07-29T07:00:00Z', 'ok')`,
    )
      .bind(HOSTING)
      .run()
    await env.DB.prepare("INSERT INTO sources (run_id, ordinal, url, domain) VALUES ('2026-07-29:chatgpt:cut', 0, ?, ?)")
      .bind(`https://${ORPHANED}/best-mics`, ORPHANED)
      .run()

    await sweepCiting(classifierReply({ [UNSEEN]: 'Editorial', [ORPHANED]: 'UGC' }))

    expect(await domainRow(ORPHANED)).toEqual({ domain_type: 'UGC', classified_by: 'llm' })
  })

  it('classifies more Domains than D1 allows bound parameters in one query', async () => {
    await syncConfig()
    // D1 rejects a query with over 100 bound parameters. Building one `IN` list
    // per Domain threw the whole pass away on any real day — 2026-07-30 cited 312.
    const many = Array.from({ length: 150 }, (_, index) => `example${index}.test`)
    providers = fakeProviders(({ body }) =>
      isClassifierCall(body) ? classifierReply(Object.fromEntries(many.map((domain) => [domain, 'Editorial']))) : openaiNoSearch,
    )

    await classifyNewDomains(env.DB, many, env)

    const classified = await env.DB.prepare("SELECT COUNT(*) AS total FROM domains WHERE domain LIKE 'example%.test'")
      .first<{ total: number }>()
    expect(classified?.total).toBe(150)
  })

  it('asks the classifier for few enough Domains per call to answer in time', async () => {
    await syncConfig()
    // 100 per call never returned inside the 30s budget, so every backfill
    // failed and 280 Domains sat unclassified with no way to drain.
    const many = Array.from({ length: 150 }, (_, index) => `batched${index}.test`)
    providers = fakeProviders(({ body }) =>
      isClassifierCall(body) ? classifierReply(Object.fromEntries(many.map((domain) => [domain, 'Editorial']))) : openaiNoSearch,
    )

    await classifyNewDomains(env.DB, many, env)

    const sizes = providers
      .callsTo('api.openai.com')
      .filter((call) => isClassifierCall(call.body))
      .map((call) => ((call.body as { input?: string }).input ?? '').split('\n').length)
    expect(sizes.length).toBeGreaterThan(1)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(25)
  })

  it('drains a backlog larger than one call can hold', async () => {
    await syncConfig()
    const many = Array.from({ length: 150 }, (_, index) => `backlog${index}.test`)
    providers = fakeProviders(({ body }) =>
      isClassifierCall(body) ? classifierReply(Object.fromEntries(many.map((domain) => [domain, 'UGC']))) : openaiNoSearch,
    )

    await classifyNewDomains(env.DB, many, env)

    const classified = await env.DB.prepare("SELECT COUNT(*) AS total FROM domains WHERE domain LIKE 'backlog%.test'")
      .first<{ total: number }>()
    expect(classified?.total).toBe(150)
  })

  it('keeps the Domains from batches that answered when one batch fails', async () => {
    await syncConfig()
    const many = Array.from({ length: 60 }, (_, index) => `partial${index}.test`)
    let call = 0
    providers = fakeProviders(({ body }) => {
      if (!isClassifierCall(body)) return openaiNoSearch
      // One batch failing must not cost the others, or a busy day loses everything.
      return ++call === 1 ? { status: 500, body: { error: 'classifier down' } } : classifierReply(Object.fromEntries(many.map((d) => [d, 'Editorial'])))
    })

    await classifyNewDomains(env.DB, many, env)

    const classified = await env.DB.prepare("SELECT COUNT(*) AS total FROM domains WHERE domain LIKE 'partial%.test'")
      .first<{ total: number }>()
    expect(classified?.total).toBe(35)
  })

  it('never reclassifies a Domain once assigned', async () => {
    await syncConfig()
    await env.DB.prepare(
      "INSERT INTO domains (domain, domain_type, classified_by, classified_at) VALUES (?, 'UGC', 'llm', '2026-01-01T00:00:00Z')",
    )
      .bind(UNSEEN)
      .run()

    await sweepCiting(classifierReply({ [UNSEEN]: 'Corporate' }))

    // The original assignment stands, so historical breakdowns stay stable.
    expect(await domainRow(UNSEEN)).toEqual({ domain_type: 'UGC', classified_by: 'llm' })
  })
})

describe('sources view', () => {
  const FROM = '2026-07-20'
  const TO = '2026-07-26'
  const sources = (query = '') => getHtml(`/sources?from=${FROM}&to=${TO}${query}`)

  beforeEach(async () => {
    await syncConfig()
    await seedRuns([
      {
        promptId: HOSTING,
        surface: 'perplexity',
        date: '2026-07-20',
        responseText: 'Castos and Transistor lead.',
        citations: [
          'https://www.reddit.com/r/podcasting/a',
          'https://old.reddit.com/r/podcasting/b',
          'https://www.techradar.com/best/hosting',
          'https://castos.com/features/',
        ],
      },
      {
        promptId: HOSTING,
        surface: 'perplexity',
        date: '2026-07-21',
        responseText: 'Transistor is popular.',
        citations: ['https://www.reddit.com/r/podcasting/c', 'https://transistor.fm/'],
      },
      {
        promptId: ANALYTICS,
        surface: 'chatgpt',
        date: '2026-07-22',
        responseText: 'Analytics vary by host.',
        citations: ['https://www.techradar.com/best/analytics'],
      },
    ])

    await env.DB.batch(
      [
        ['reddit.com', 'UGC', 'seed'],
        ['techradar.com', 'Editorial', 'seed'],
        ['transistor.fm', 'Competitor', 'seed'],
        ['castos.com', 'You', 'brand'],
      ].map(([domain, type, by]) =>
        env.DB.prepare(
          'INSERT INTO domains (domain, domain_type, classified_by, classified_at) VALUES (?, ?, ?, ?)',
        ).bind(domain, type, by, '2026-07-01T00:00:00Z'),
      ),
    )
  })

  it('ranks Domains by retrieval count', async () => {
    const html = await sources()

    // reddit.com cited 3 times, techradar.com twice, then a tie broken by name.
    expect(attributeOrder(html, 'data-domain')).toEqual(['reddit.com', 'techradar.com', 'castos.com', 'transistor.fm'])
    expect(block(html, 'data-domain', 'reddit.com')).toContain('data-retrieved="3"')
  })

  it('reports retrieval rate as the share of Runs citing the Domain', async () => {
    const html = await sources()

    // reddit.com appears in 2 of the 3 Runs, despite 3 citations.
    expect(block(html, 'data-domain', 'reddit.com')).toContain('66.7%')
    expect(block(html, 'data-domain', 'castos.com')).toContain('33.3%')
  })

  it('breaks citations down by Domain Type', async () => {
    const html = await sources()

    // 7 citations: 3 UGC, 2 Editorial, 1 You, 1 Competitor.
    expect(block(html, 'data-type', 'UGC', 'span')).toContain('42.9%')
    expect(block(html, 'data-type', 'Editorial', 'span')).toContain('28.6%')
    expect(block(html, 'data-type', 'You', 'span')).toContain('14.3%')
  })

  it('marks castos.com as You and shows its rank among cited Domains', async () => {
    const html = await sources()

    expect(block(html, 'data-domain', 'castos.com')).toContain('class="tag self"')
    expect(html).toContain('data-self-rank="3"')
  })

  it('honours the Surface filter', async () => {
    const html = await sources('&surface=chatgpt')

    // Only the analytics Run remains, which cited techradar.com alone.
    expect(attributeOrder(html, 'data-domain')).toEqual(['techradar.com'])
    expect(html).toContain('data-self-rank="none"')
  })

  it('honours the Topic filter', async () => {
    const html = await sources('&topic=podcast-hosting-platforms')

    expect(attributeOrder(html, 'data-domain')).toEqual(['reddit.com', 'castos.com', 'techradar.com', 'transistor.fm'])
  })
})
