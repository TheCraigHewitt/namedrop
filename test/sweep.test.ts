import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { runId, utcDate } from '../src/lib/collection/sweep'
import { PROMPTS } from '../src/lib/config'
import cloroDefault from './fixtures/cloro/default.json'
import geminiDefault from './fixtures/gemini/default.json'
import ambiguousAnchor from './fixtures/perplexity/ambiguous-anchor.json'
import anchorAsBrand from './fixtures/perplexity/anchor-as-brand.json'
import defaultAnswer from './fixtures/perplexity/default.json'
import hostingPlatforms from './fixtures/perplexity/hosting-platforms.json'
import noBrands from './fixtures/perplexity/no-brands.json'
import noCitations from './fixtures/perplexity/no-citations.json'
import { fakeProviders, promptTextOf, type FakeProviders } from './fake-providers'
import { post, runCron, syncConfig } from './helpers'

/** Prompts chosen to carry each edge case through a real sweep. */
const FIXTURE_BY_PROMPT: Record<string, unknown> = {
  'podcast-hosting-platforms-01': hostingPlatforms,
  'podcast-analytics-tools-01': noBrands,
  'private-podcast-hosting-services-01': noCitations,
  'podcast-monetization-01': ambiguousAnchor,
  'podcast-distribution-software-01': anchorAsBrand,
}

/** This Prompt's Surface call always fails, so the sweep must survive it. */
const FAILING_PROMPT = 'wordpress-podcasting-plugins-01'

/** This Prompt's ChatGPT call always runs out of time. */
const TIMING_OUT_PROMPT = 'podcast-analytics-tools-02'

/** What `AbortSignal.timeout` rejects with once a provider call exceeds its budget. */
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })

const textOf = (promptId: string) => PROMPTS.find((prompt) => prompt.id === promptId)!.text

const fixtureByText = new Map(
  Object.entries(FIXTURE_BY_PROMPT).map(([promptId, fixture]) => [textOf(promptId), fixture]),
)

const today = utcDate()
const perplexityRun = (promptId: string) => runId(today, 'perplexity', promptId)

/** Every active Prompt against all three Surfaces. */
const EXPECTED_RUNS = PROMPTS.length * 3

let providers: FakeProviders

beforeEach(() => {
  providers = fakeProviders(({ host, body }) => {
    const promptText = promptTextOf(body)
    if (host === 'api.cloro.dev') return cloroDefault
    if (host === 'generativelanguage.googleapis.com') return geminiDefault

    // Only Perplexity fails for this Prompt, so the other Surfaces still land.
    if (promptText === textOf(FAILING_PROMPT)) {
      return { status: 500, body: { error: { message: 'upstream unavailable' } } }
    }
    return fixtureByText.get(promptText) ?? defaultAnswer
  })
})

const mentionsFor = async (runIdValue: string) =>
  (
    await env.DB.prepare('SELECT brand_id, position, mention_count FROM mentions WHERE run_id = ? ORDER BY position')
      .bind(runIdValue)
      .all<{ brand_id: string; position: number; mention_count: number }>()
  ).results

describe('daily sweep', () => {
  it('runs every active Prompt against every Surface', async () => {
    await runCron()

    const bySurface = (
      await env.DB.prepare('SELECT surface, COUNT(*) AS total FROM runs WHERE run_date = ? GROUP BY surface ORDER BY surface')
        .bind(today)
        .all<{ surface: string; total: number }>()
    ).results
    expect(bySurface).toEqual([
      { surface: 'chatgpt', total: PROMPTS.length },
      { surface: 'gemini', total: PROMPTS.length },
      { surface: 'perplexity', total: PROMPTS.length },
    ])
  })

  it('records one sweep per Surface, so a Surface that never runs leaves a visible gap', async () => {
    await runCron()

    const sweeps = (
      await env.DB.prepare('SELECT surface, status, ok_count, failed_count, completed_at FROM sweeps ORDER BY surface')
        .all<{ surface: string; status: string; ok_count: number; failed_count: number; completed_at: string | null }>()
    ).results

    // Only the Perplexity call fails for FAILING_PROMPT, so only its sweep is partial.
    expect(sweeps).toEqual([
      { surface: 'chatgpt', status: 'ok', ok_count: PROMPTS.length, failed_count: 0, completed_at: expect.any(String) },
      { surface: 'gemini', status: 'ok', ok_count: PROMPTS.length, failed_count: 0, completed_at: expect.any(String) },
      { surface: 'perplexity', status: 'partial', ok_count: PROMPTS.length - 1, failed_count: 1, completed_at: expect.any(String) },
    ])
  })

  it('counts each Run against its sweep as it lands, so a truncated sweep still reports what it collected', async () => {
    // Fire only the ChatGPT schedule, then read the counts back before the other
    // Surfaces run — the same view a sweep killed at the Cron Trigger cap leaves.
    await runCron(undefined, ['0 7 * * *'])

    const sweep = await env.DB.prepare('SELECT surface, ok_count, failed_count FROM sweeps')
      .first<{ surface: string; ok_count: number; failed_count: number }>()
    expect(sweep).toEqual({ surface: 'chatgpt', ok_count: PROMPTS.length, failed_count: 0 })
  })

  it('stores the verbatim Response, its Sources in citation order, and its Fanouts', async () => {
    await runCron()
    const id = perplexityRun('podcast-hosting-platforms-01')

    const run = await env.DB.prepare('SELECT status, model, response_text FROM runs WHERE id = ?')
      .bind(id)
      .first<{ status: string; model: string; response_text: string }>()
    expect(run?.status).toBe('ok')
    expect(run?.model).toBe('sonar')
    expect(run?.response_text).toBe(hostingPlatforms.choices[0]!.message.content)

    const sources = (
      await env.DB.prepare('SELECT ordinal, url, domain, title FROM sources WHERE run_id = ? ORDER BY ordinal')
        .bind(id)
        .all<{ ordinal: number; url: string; domain: string; title: string }>()
    ).results
    expect(sources.map((source) => source.domain)).toEqual([
      'techradar.com',
      'transistor.fm',
      'reddit.com',
      'reddit.com',
      'castos.com',
    ])
    expect(sources[0]!.title).toBe('Best podcast hosting platforms in 2026')

    const fanouts = (
      await env.DB.prepare('SELECT query FROM fanouts WHERE run_id = ? ORDER BY ordinal').bind(id).all<{ query: string }>()
    ).results
    expect(fanouts.map((fanout) => fanout.query)).toEqual([
      'best podcast hosting platforms 2026',
      'podcast hosting comparison unlimited shows',
    ])
  })

  it('records Position as the order Brands first appear in the Response', async () => {
    await runCron()

    const mentions = await mentionsFor(perplexityRun('podcast-hosting-platforms-01'))
    expect(mentions.map((mention) => [mention.brand_id, mention.position])).toEqual([
      ['transistor', 1],
      ['buzzsprout', 2],
      ['castos', 3],
      ['captivate', 4],
    ])
  })

  it('rolls duplicate citations of one Domain up to a single Domain', async () => {
    await runCron()
    const id = perplexityRun('podcast-hosting-platforms-01')

    const domains = await env.DB.prepare(
      'SELECT COUNT(*) AS sources, COUNT(DISTINCT domain) AS domains FROM sources WHERE run_id = ?',
    )
      .bind(id)
      .first<{ sources: number; domains: number }>()

    // Two distinct reddit.com URLs are two Sources but one Domain.
    expect(domains).toEqual({ sources: 5, domains: 4 })
  })

  it('stores a Run with no Mentions when no tracked Brand appears', async () => {
    await runCron()
    const id = perplexityRun('podcast-analytics-tools-01')

    const run = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(id).first<{ status: string }>()
    expect(run?.status).toBe('ok')
    expect(await mentionsFor(id)).toEqual([])
  })

  it('stores a Run with no Sources when a Surface returns no citations', async () => {
    await runCron()
    const id = perplexityRun('private-podcast-hosting-services-01')

    const sources = await env.DB.prepare('SELECT COUNT(*) AS total FROM sources WHERE run_id = ?')
      .bind(id)
      .first<{ total: number }>()
    expect(sources?.total).toBe(0)
    expect((await mentionsFor(id)).map((mention) => mention.brand_id)).toEqual(['castos', 'libsyn'])
  })

  it('does not count an ambiguous alias used as an ordinary word', async () => {
    await runCron()

    // "anchor text" and "anchor your promotion" are not the Anchor Brand.
    const mentions = await mentionsFor(perplexityRun('podcast-monetization-01'))
    expect(mentions.map((mention) => mention.brand_id)).toEqual(['podbean', 'castos'])
  })

  it('counts the same ambiguous alias when it names the Brand', async () => {
    await runCron()

    const mentions = await mentionsFor(perplexityRun('podcast-distribution-software-01'))
    expect(mentions.map((mention) => [mention.brand_id, mention.position])).toEqual([
      ['anchor', 1],
      ['podbean', 2],
      ['castos', 3],
    ])
    // "Anchor" and "Spotify for Podcasters" are the same Brand named twice.
    expect(mentions[0]!.mention_count).toBe(2)
  })

  it('retries a failing Surface call, records a failed Run, and finishes the sweep', async () => {
    await runCron()
    const id = perplexityRun(FAILING_PROMPT)

    const run = await env.DB.prepare('SELECT status, error, response_text FROM runs WHERE id = ?')
      .bind(id)
      .first<{ status: string; error: string; response_text: string | null }>()
    expect(run?.status).toBe('failed')
    expect(run?.error).toContain('500')
    expect(run?.response_text).toBeNull()

    const attempts = providers.callsTo('api.perplexity.ai').filter(({ body }) => promptTextOf(body) === textOf(FAILING_PROMPT))
    expect(attempts).toHaveLength(2)

    // The rest of the sweep still landed, including the other Surfaces for this Prompt.
    const ok = await env.DB.prepare("SELECT COUNT(*) AS total FROM runs WHERE status = 'ok'").first<{ total: number }>()
    expect(ok?.total).toBe(EXPECTED_RUNS - 1)
  })

  it('does not retry a call that ran out of time', async () => {
    providers = fakeProviders(({ host, body }) => {
      if (host === 'api.cloro.dev' && promptTextOf(body) === textOf(TIMING_OUT_PROMPT)) throw timeoutError()
      if (host === 'api.cloro.dev') return cloroDefault
      if (host === 'generativelanguage.googleapis.com') return geminiDefault
      return defaultAnswer
    })

    await runCron(undefined, ['0 7 * * *'])

    // A second attempt costs another full timeout of the sweep's budget and, in
    // production, timed out again every time.
    const attempts = providers.callsTo('api.cloro.dev').filter(({ body }) => promptTextOf(body) === textOf(TIMING_OUT_PROMPT))
    expect(attempts).toHaveLength(1)

    const run = await env.DB.prepare('SELECT status, error FROM runs WHERE id = ?')
      .bind(runId(today, 'chatgpt', TIMING_OUT_PROMPT))
      .first<{ status: string; error: string }>()
    expect(run?.status).toBe('failed')
    expect(run?.error).toContain('timeout')
  })

  it('keeps a Run that already succeeded when re-running the date fails', async () => {
    await runCron(undefined, ['20 7 * * *'])
    const id = perplexityRun('podcast-hosting-platforms-01')

    const collected = await env.DB.prepare('SELECT status, response_text FROM runs WHERE id = ?')
      .bind(id)
      .first<{ status: string; response_text: string }>()
    expect(collected?.status).toBe('ok')

    // The provider has broken since — an exhausted quota, a revoked key. Re-running
    // the date must not destroy the day it was meant to repair.
    providers = fakeProviders(() => ({ status: 429, body: { error: { message: 'You exceeded your current quota' } } }))
    await runCron(undefined, ['20 7 * * *'])

    expect(
      await env.DB.prepare('SELECT status, response_text FROM runs WHERE id = ?').bind(id).first(),
    ).toEqual(collected)

    // Everything hanging off the Run survives with it.
    expect((await mentionsFor(id)).map((mention) => mention.brand_id)).toEqual(['transistor', 'buzzsprout', 'castos', 'captivate'])

    // The sweep still reports the failure, because the sweep did fail.
    const sweep = await env.DB.prepare("SELECT ok_count, failed_count FROM sweeps WHERE surface = 'perplexity' ORDER BY started_at DESC")
      .first<{ ok_count: number; failed_count: number }>()
    expect(sweep).toEqual({ ok_count: 0, failed_count: PROMPTS.length })
    // Every Prompt failing means every Prompt sits through its retry backoff.
  }, 30_000)

  it('records a failed Run when the date has nothing collected to protect', async () => {
    providers = fakeProviders(() => ({ status: 429, body: { error: { message: 'You exceeded your current quota' } } }))
    await runCron(undefined, ['20 7 * * *'])

    const run = await env.DB.prepare('SELECT status, error FROM runs WHERE id = ?')
      .bind(perplexityRun('podcast-hosting-platforms-01'))
      .first<{ status: string; error: string }>()
    expect(run?.status).toBe('failed')
    expect(run?.error).toContain('429')
  }, 30_000)

  it('replaces a day’s Runs rather than duplicating them when the sweep re-runs', async () => {
    await runCron()
    await runCron()

    const counts = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM runs) AS runs,
              (SELECT COUNT(*) FROM mentions WHERE run_id = ?) AS mentions,
              (SELECT COUNT(*) FROM sources WHERE run_id = ?) AS sources,
              (SELECT COUNT(*) FROM fanouts WHERE run_id = ?) AS fanouts`,
    )
      .bind(perplexityRun('podcast-hosting-platforms-01'), perplexityRun('podcast-hosting-platforms-01'), perplexityRun('podcast-hosting-platforms-01'))
      .first<{ runs: number; mentions: number; sources: number; fanouts: number }>()

    expect(counts).toEqual({ runs: EXPECTED_RUNS, mentions: 4, sources: 5, fanouts: 2 })
  })
})

describe('ChatGPT collection request', () => {
  it('asks cloro for a US chatgpt.com session with its Fanouts', async () => {
    await runCron(undefined, ['0 7 * * *'])

    // The Surface tracks the product: a real chatgpt.com session via cloro,
    // not an API model pin of ours. Web search needs no toggle there.
    const call = providers.callsTo('api.cloro.dev')[0]!
    expect(call.body).toMatchObject({ country: 'US', include: { searchQueries: true } })
    expect(typeof (call.body as { prompt?: string }).prompt).toBe('string')
  })
})

describe('token usage', () => {
  const usageOf = (surface: string, promptId: string) =>
    env.DB.prepare(
      'SELECT input_tokens, output_tokens, reasoning_tokens, cached_input_tokens FROM runs WHERE id = ?',
    )
      .bind(runId(today, surface, promptId))
      .first<{ input_tokens: number; output_tokens: number; reasoning_tokens: number; cached_input_tokens: number }>()

  it('stores no token usage for ChatGPT, which cloro bills flat per request', async () => {
    await runCron(undefined, ['0 7 * * *'])

    // Nulls, not zeros: a zero would read as measured. ChatGPT Runs before
    // 2026-08-06 carry real token counts from the API era.
    expect(await usageOf('chatgpt', 'podcast-hosting-platforms-01')).toEqual({
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cached_input_tokens: null,
    })
  })

  it('records Gemini’s thinking tokens, which bill like OpenAI’s reasoning', async () => {
    await runCron(undefined, ['40 7 * * *'])

    const usage = await usageOf('gemini', 'podcast-hosting-platforms-01')
    expect(usage?.reasoning_tokens).toBe(9)
  })

  it('records Perplexity usage without inventing a reasoning count', async () => {
    await runCron(undefined, ['20 7 * * *'])

    // Sonar neither reasons nor cache-prices, so a zero here would read as measured.
    expect(await usageOf('perplexity', 'podcast-hosting-platforms-01')).toEqual({
      input_tokens: 14,
      output_tokens: 96,
      reasoning_tokens: null,
      cached_input_tokens: null,
    })
  })

  it('records how long the provider call took', async () => {
    await runCron(undefined, ['0 7 * * *'])

    const run = await env.DB.prepare('SELECT duration_ms FROM runs WHERE id = ?')
      .bind(runId(today, 'chatgpt', 'podcast-hosting-platforms-01'))
      .first<{ duration_ms: number }>()
    expect(run?.duration_ms).toBeGreaterThanOrEqual(0)
  })
})

describe('resuming a part-way sweep', () => {
  const chatgptCalls = () => providers.callsTo('api.cloro.dev').length

  const COLLECTED = PROMPTS[0]!

  /**
   * A sweep that collected one Prompt and lost the rest — the shape a client
   * disconnect or a mid-sweep quota exhaustion leaves behind. The failures are
   * real Runs, so resume has to key off status rather than absence.
   */
  const collectOnePrompt = async () => {
    await syncConfig()
    providers = fakeProviders(({ body }) =>
      promptTextOf(body) === COLLECTED.text ? cloroDefault : { status: 500, body: { error: { message: 'upstream unavailable' } } },
    )
    await post(`/api/sweep?surface=chatgpt&date=${today}`)
    providers = fakeProviders(() => cloroDefault)
  }

  it('collects only the Prompts with no successful Run yet', async () => {
    await collectOnePrompt()
    const before = chatgptCalls()

    await post(`/api/sweep?surface=chatgpt&date=${today}&resume=true`)

    // The one Prompt already collected is not bought a second time.
    expect(chatgptCalls() - before).toBe(PROMPTS.length - 1)
  }, 30_000)

  it('leaves the already-collected Run untouched', async () => {
    await collectOnePrompt()
    const kept = runId(today, 'chatgpt', PROMPTS[0]!.id)
    const originalCreatedAt = (
      await env.DB.prepare('SELECT created_at FROM runs WHERE id = ?').bind(kept).first<{ created_at: string }>()
    )?.created_at

    await post(`/api/sweep?surface=chatgpt&date=${today}&resume=true`)

    const after = await env.DB.prepare('SELECT created_at FROM runs WHERE id = ?').bind(kept).first<{ created_at: string }>()
    expect(after?.created_at).toBe(originalCreatedAt)
  }, 30_000)

  it('ends the date with every Prompt collected', async () => {
    await collectOnePrompt()

    await post(`/api/sweep?surface=chatgpt&date=${today}&resume=true`)

    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE surface = 'chatgpt' AND status = 'ok'")
      .first<{ n: number }>()
    expect(total?.n).toBe(PROMPTS.length)
  }, 30_000)

  it('re-collects everything when resume is not asked for', async () => {
    await collectOnePrompt()
    const before = chatgptCalls()

    await post(`/api/sweep?surface=chatgpt&date=${today}`)

    // The default contract is still that re-running a date collects it afresh.
    expect(chatgptCalls() - before).toBe(PROMPTS.length)
  }, 30_000)
})
