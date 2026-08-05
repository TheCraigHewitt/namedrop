import { env } from 'cloudflare:workers'
import type { APIRoute } from 'astro'
import { BRANDS } from '../../lib/config'
import { detectMentions } from '../../lib/mentions'
import { chatgptRequestBody, parseChatgptBody, usageOf, type ChatgptOptions } from '../../lib/surfaces/chatgpt'

/**
 * Measures what a ChatGPT Prompt costs under different settings, so the choice
 * between them is arithmetic rather than argument. Collection ran with neither
 * reasoning effort nor search context size set until 2026-08-02, and at ~$9 a
 * day the question was whether those defaults were the bill.
 *
 * Deliberately writes nothing: this samples a few Prompts many times over, and
 * storing that would put non-comparable Runs into the trend data. The Brands it
 * reports come from the real detector, because a config that halves the cost
 * while changing who gets mentioned has not saved anything.
 */
const CONFIGS: { label: string; options: ChatgptOptions }[] = [
  { label: 'gpt-5 effort:low (collection until 2026-08-04)', options: { model: 'gpt-5', reasoningEffort: 'low' } },
  { label: 'gpt-5 effort:low + search:low', options: { model: 'gpt-5', reasoningEffort: 'low', searchContextSize: 'low' } },
  // Token prices a fifth of gpt-5's; the flat search fee is unchanged, so the
  // question is whether the cheaper model names the same Brands.
  { label: 'gpt-5-mini effort:low', options: { model: 'gpt-5-mini', reasoningEffort: 'low' } },
  { label: 'gpt-5-mini effort:low + search:low', options: { model: 'gpt-5-mini', reasoningEffort: 'low', searchContextSize: 'low' } },
  // What ChatGPT actually serves most users since 2026-07-09 — the fidelity
  // candidate, not the cheap one.
  { label: 'gpt-5.6-terra effort:low', options: { model: 'gpt-5.6-terra', reasoningEffort: 'low' } },
  { label: 'gpt-5.6-luna effort:low', options: { model: 'gpt-5.6-luna', reasoningEffort: 'low' } },
  // Terra at the API default: fast without an effort cap, and the most
  // faithful setting available. What collection runs since 2026-08-04.
  { label: 'gpt-5.6-terra default (collection since 2026-08-04)', options: { model: 'gpt-5.6-terra' } },
]

const CALL_TIMEOUT_MS = 180_000

/**
 * One config per request, with its Prompts in parallel. All four configs in one
 * request would need the better part of an hour, and Cloudflare cuts a request
 * off after about six minutes. Every config runs at the same concurrency, so
 * whatever contention adds to latency it adds to all of them alike.
 */
export const POST: APIRoute = async ({ url }) => {
  const index = Number(url.searchParams.get('config') ?? 0)
  const config = CONFIGS[index]
  if (!config) return json({ error: `config must be 0..${CONFIGS.length - 1}`, configs: CONFIGS.map((c) => c.label) }, 400)

  const sampleSize = Math.min(Math.max(Number(url.searchParams.get('prompts') ?? 5), 1), 12)

  // One Prompt per Topic. Taking the first N by id drew all five from the
  // analytics Topic on the first run, and none of them mentioned the self Brand — a
  // sample that cannot answer whether a config changes what we measure.
  const { results: prompts } = await env.DB.prepare(
    `SELECT id, text FROM (
       SELECT p.id, p.text, ROW_NUMBER() OVER (PARTITION BY p.topic_id ORDER BY p.id) AS rank
       FROM prompts p WHERE p.active = 1
     ) WHERE rank = 1 ORDER BY id LIMIT ?`,
  )
    .bind(sampleSize)
    .all<{ id: string; text: string }>()

  if (prompts.length === 0) return json({ error: 'no active Prompts — run /api/sync-config first' }, 400)

  const results = await Promise.all(
    prompts.map(async (prompt) => ({ promptId: prompt.id, ...(await measure(prompt.text, config.options)) })),
  )

  return json({ config: config.label, prompts: prompts.length, results }, 200)
}

async function measure(promptText: string, options: ChatgptOptions) {
  const startedAt = Date.now()
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(chatgptRequestBody(promptText, options)),
    })

    if (!response.ok) {
      return { error: `OpenAI ${response.status}: ${(await response.text()).slice(0, 120)}`, ms: Date.now() - startedAt }
    }

    const body = (await response.json()) as Parameters<typeof parseChatgptBody>[0] & { usage?: Parameters<typeof usageOf>[0] }
    const parsed = parseChatgptBody(body)
    const usage = usageOf(body.usage)

    return {
      ms: Date.now() - startedAt,
      // The resolved model version, so a silent alias change shows up in the sample.
      model: parsed.model,
      ...usage,
      fanouts: parsed.fanouts.length,
      citations: parsed.citations.length,
      answerChars: parsed.answerText.length,
      brands: detectMentions(parsed.answerText, BRANDS).map((mention) => mention.brandId),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ms: Date.now() - startedAt }
  }
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } })
