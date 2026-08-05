/** Perplexity Sonar API — https://docs.perplexity.ai/api-reference/chat-completions */
import type { SurfaceAdapter, SurfaceResponse } from '../types'

const ENDPOINT = 'https://api.perplexity.ai/chat/completions'
const MODEL = 'sonar'

interface SonarResponse {
  model?: string
  choices?: { message?: { content?: string } }[]
  /** Newer field carrying titles alongside URLs. */
  search_results?: { url?: string; title?: string }[]
  /** Older field: citation URLs in the order the answer references them. */
  citations?: string[]
  /** Present when Sonar reports the searches it ran. */
  search_queries?: string[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export const perplexityAdapter: SurfaceAdapter = {
  surface: 'perplexity',

  async run(promptText, env, signal): Promise<SurfaceResponse> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      signal: signal ?? null,
      headers: {
        authorization: `Bearer ${env.PERPLEXITY_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: promptText }],
      }),
    })

    if (!response.ok) {
      throw new Error(`Perplexity ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }

    const body = (await response.json()) as SonarResponse
    const answerText = body.choices?.[0]?.message?.content ?? ''
    if (answerText === '') throw new Error('Perplexity returned an empty answer')

    return {
      answerText,
      model: body.model ?? MODEL,
      citations: normalizeCitations(body),
      // Sonar only sometimes reports the searches it ran; absent means no Fanouts,
      // never invented ones.
      fanouts: body.search_queries ?? [],
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? null,
        outputTokens: body.usage?.completion_tokens ?? null,
        // Sonar does not reason or cache-price, so these stay empty rather than zero.
        reasoningTokens: null,
        cachedInputTokens: null,
      },
    }
  },
}

/**
 * Prefers search_results (it carries titles) and falls back to the citations
 * array, keeping citation order and dropping duplicate URLs.
 */
function normalizeCitations(body: SonarResponse): { url: string; title?: string }[] {
  const ordered = body.search_results?.length
    ? body.search_results.map((result) => ({ url: result.url ?? '', title: result.title }))
    : (body.citations ?? []).map((url) => ({ url }))

  const seen = new Set<string>()
  return ordered.filter((citation) => {
    if (citation.url === '' || seen.has(citation.url)) return false
    seen.add(citation.url)
    return true
  })
}
