/**
 * Gemini with Google Search grounding — the stand-in for Google AI Overviews,
 * since no official AI Overview API exists.
 * https://ai.google.dev/gemini-api/docs/google-search
 *
 * Its grounding chunks cite a Google redirect URL rather than the source, and
 * put the real site in the chunk title. The redirect is kept as the Source URL
 * (it is what was returned) but the Domain comes from the title, or every
 * Gemini citation would roll up to google.com.
 */
import type { Citation, SurfaceAdapter, SurfaceResponse } from '../types'

const MODEL = 'gemini-2.5-flash'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com'

interface GeminiBody {
  modelVersion?: string
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    cachedContentTokenCount?: number
  }
  candidates?: {
    content?: { parts?: { text?: string }[] }
    groundingMetadata?: {
      webSearchQueries?: string[]
      groundingChunks?: { web?: { uri?: string; title?: string; domain?: string } }[]
    }
  }[]
}

export const geminiAdapter: SurfaceAdapter = {
  surface: 'gemini',

  async run(promptText, env, signal): Promise<SurfaceResponse> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      signal: signal ?? null,
      headers: {
        // Header rather than a query param, so the key stays out of URLs and logs.
        'x-goog-api-key': env.GEMINI_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        tools: [{ google_search: {} }],
      }),
    })

    if (!response.ok) {
      throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }

    const body = (await response.json()) as GeminiBody
    const candidate = body.candidates?.[0]

    const answerText = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim()

    if (answerText === '') throw new Error('Gemini returned an empty answer')

    const grounding = candidate?.groundingMetadata
    const seen = new Set<string>()
    const citations: Citation[] = []

    for (const chunk of grounding?.groundingChunks ?? []) {
      const url = chunk.web?.uri
      if (!url || seen.has(url)) continue
      seen.add(url)
      citations.push({ url, title: chunk.web?.title, domain: realDomain(url, chunk.web) })
    }

    return {
      answerText,
      model: body.modelVersion ?? MODEL,
      citations,
      // Grounding reports the searches verbatim — these are the truest Fanouts we get.
      fanouts: grounding?.webSearchQueries ?? [],
      usage: {
        inputTokens: body.usageMetadata?.promptTokenCount ?? null,
        outputTokens: body.usageMetadata?.candidatesTokenCount ?? null,
        // 2.5 Flash thinks by default, and thoughts bill as output like OpenAI's.
        reasoningTokens: body.usageMetadata?.thoughtsTokenCount ?? null,
        cachedInputTokens: body.usageMetadata?.cachedContentTokenCount ?? null,
      },
    }
  },
}

/**
 * The Domain a grounding chunk really points at. Behind a Google redirect the
 * only signal is the chunk's own domain/title field, which Gemini populates
 * with the site (e.g. "techradar.com").
 */
function realDomain(url: string, web: { title?: string; domain?: string } | undefined): string | undefined {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return undefined
  }
  if (host !== GROUNDING_REDIRECT_HOST) return undefined

  const hint = web?.domain ?? web?.title
  if (!hint) return undefined

  // Titles are sometimes a bare domain and sometimes a full URL.
  const candidate = hint.includes('://') ? hint : `https://${hint}`
  try {
    return new URL(candidate).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return undefined
  }
}
