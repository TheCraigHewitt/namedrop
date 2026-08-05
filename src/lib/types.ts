/** Domain vocabulary — see CONTEXT.md. */

export const SURFACES = ['chatgpt', 'perplexity', 'gemini'] as const
export type SurfaceId = (typeof SURFACES)[number]

export const SURFACE_LABELS: Record<SurfaceId, string> = {
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
}

export const DOMAIN_TYPES = [
  'Corporate',
  'UGC',
  'Editorial',
  'Reference',
  'Institutional',
  'Competitor',
  'You',
  'Other',
] as const
export type DomainType = (typeof DOMAIN_TYPES)[number]

export interface Topic {
  id: string
  name: string
}

export interface Prompt {
  id: string
  topicId: string
  text: string
  intent?: string
  branding?: string
}

export interface Alias {
  text: string
  /** Words that veto a match, so ambiguous aliases ("Anchor") skip "anchor text". */
  notFollowedBy: string[]
}

export interface Brand {
  id: string
  name: string
  isSelf: boolean
  domains: string[]
  aliases: Alias[]
}

/** A Brand detected in a Response. */
export interface Mention {
  brandId: string
  /** Order of first appearance among all Brands mentioned in this Response. */
  position: number
  /** Character offset of the first match, the basis for Position ordering. */
  firstIndex: number
  count: number
}

export interface Citation {
  url: string
  title?: string
  /**
   * The registrable Domain, when the adapter knows it better than the URL does.
   * Gemini returns grounding redirects through Google, so the real Domain is
   * only available from the grounding metadata.
   */
  domain?: string
}

/** What a Surface returned for one Run, normalized across adapters. */
/**
 * What the provider says the call cost. Reasoning tokens are a subset of
 * outputTokens rather than an addition to them, and they bill at the output
 * rate — which is why they are worth separating out.
 */
export interface Usage {
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cachedInputTokens: number | null
}

export interface SurfaceResponse {
  answerText: string
  model: string
  citations: Citation[]
  fanouts: string[]
  usage?: Usage
}

export interface SurfaceAdapter {
  readonly surface: SurfaceId
  /** Runs one Prompt. Throws on transport or API error; the sweep handles retry. */
  run(promptText: string, env: Cloudflare.Env, signal?: AbortSignal): Promise<SurfaceResponse>
}
