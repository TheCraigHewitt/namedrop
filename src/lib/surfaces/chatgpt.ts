/**
 * ChatGPT — collected from a real chatgpt.com session via cloro.dev since
 * 2026-08-06. The Surface tracks the product, and any API pin is only a guess
 * at what OpenAI's router serves: the gpt-5.6-terra guess measured as gpt-5-5
 * on real sessions the day it was checked. cloro runs the browser session and
 * returns the answer, its sources, and the searches ChatGPT ran.
 *
 * The OpenAI Responses API path below stays for /api/calibrate — which
 * compares API configs against each other — and is the documented fallback if
 * cloro disappears (docs/costs.md).
 */
import type { Citation, SurfaceAdapter, SurfaceResponse, Usage } from '../types'

const CLORO_ENDPOINT = 'https://api.cloro.dev/v1/monitor/chatgpt'
/** Where the browser session appears to be. Every Run is US-based for now. */
const COUNTRY = 'US'

const ENDPOINT = 'https://api.openai.com/v1/responses'
/** Fallback model for the API path when a calibrate config does not pin one. */
const MODEL = 'gpt-5.6-terra'

/**
 * The two settings that drive what an API-path Prompt costs: reasoning tokens
 * bill at the output rate, and search_context_size decides how much scraped
 * page content is pulled in as input tokens. Only /api/calibrate sends these,
 * comparing configs deliberately.
 */
export interface ChatgptOptions {
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high'
  searchContextSize?: 'low' | 'medium' | 'high'
  model?: string
}

interface UsageBody {
  input_tokens?: number
  output_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number }
  input_tokens_details?: { cached_tokens?: number }
}

export const usageOf = (usage: UsageBody | undefined): Usage => ({
  inputTokens: usage?.input_tokens ?? null,
  outputTokens: usage?.output_tokens ?? null,
  reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
  cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? null,
})

/** Shared by the adapter and the calibration endpoint, so both bill identically. */
export function chatgptRequestBody(promptText: string, options: ChatgptOptions = {}): Record<string, unknown> {
  const webSearch: Record<string, unknown> = { type: 'web_search' }
  if (options.searchContextSize) webSearch.search_context_size = options.searchContextSize

  return {
    model: options.model ?? MODEL,
    input: promptText,
    tools: [webSearch],
    ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
  }
}

interface ResponsesOutputItem {
  type?: string
  action?: { type?: string; query?: string }
  content?: {
    type?: string
    text?: string
    annotations?: { type?: string; url?: string; title?: string }[]
  }[]
}

interface ResponsesBody {
  model?: string
  output?: ResponsesOutputItem[]
  usage?: UsageBody
}

/** Pulls the answer, citations and Fanouts out of a Responses API body. */
export function parseChatgptBody(body: ResponsesBody): Omit<SurfaceResponse, 'usage'> {
  const output = body.output ?? []

  const answerText = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === 'output_text')
    .map((content) => content.text ?? '')
    .join('\n')
    .trim()

  const citations: Citation[] = []
  const seen = new Set<string>()
  for (const item of output) {
    for (const content of item.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        if (annotation.type !== 'url_citation' || !annotation.url || seen.has(annotation.url)) continue
        seen.add(annotation.url)
        citations.push({ url: annotation.url, title: annotation.title })
      }
    }
  }

  // Only actual searches are Fanouts; the tool also reports page opens.
  const fanouts = output
    .filter((item) => item.type === 'web_search_call' && item.action?.type === 'search')
    .map((item) => item.action?.query ?? '')
    .filter((query) => query !== '')

  return { answerText, model: body.model ?? MODEL, citations, fanouts }
}

interface CloroBody {
  success?: boolean
  result?: {
    text?: string
    model?: string | null
    sources?: { url?: string; label?: string }[]
    searchQueries?: string[]
  }
}

/** Pulls the answer, citations and Fanouts out of a cloro extraction. */
export function parseCloroBody(body: CloroBody): Omit<SurfaceResponse, 'usage'> {
  const result = body.result ?? {}

  const citations: Citation[] = []
  const seen = new Set<string>()
  for (const source of result.sources ?? []) {
    if (!source.url || seen.has(source.url)) continue
    seen.add(source.url)
    citations.push({ url: source.url, title: source.label })
  }

  return {
    answerText: (result.text ?? '').trim(),
    // Whatever chatgpt.com routed — nullable on some of cloro's response
    // formats, and expected to move as OpenAI moves the product.
    model: result.model ?? 'chatgpt-web',
    citations,
    fanouts: (result.searchQueries ?? []).filter((query) => query !== ''),
  }
}

export const chatgptAdapter: SurfaceAdapter = {
  surface: 'chatgpt',

  async run(promptText, env, signal): Promise<SurfaceResponse> {
    const response = await fetch(CLORO_ENDPOINT, {
      method: 'POST',
      signal: signal ?? null,
      headers: {
        authorization: `Bearer ${env.CLORO_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt: promptText, country: COUNTRY, include: { searchQueries: true } }),
    })

    if (!response.ok) {
      throw new Error(`cloro ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }

    const body = (await response.json()) as CloroBody
    if (body.success !== true) {
      throw new Error(`cloro reported failure: ${JSON.stringify(body).slice(0, 200)}`)
    }

    const parsed = parseCloroBody(body)
    if (parsed.answerText === '') throw new Error('cloro returned an empty answer')

    // cloro bills a flat fee per request and reports no token usage.
    return { ...parsed, usage: usageOf(undefined) }
  },
}
