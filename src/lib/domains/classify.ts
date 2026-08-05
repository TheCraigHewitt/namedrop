/**
 * A Domain's Type is assigned once, at first sight, and then fixed — so
 * historical source-type breakdowns stay stable even as our Brand config or the
 * classifier changes.
 *
 * Precedence:
 *   1. the seed map from the Peec gap export
 *   2. Competitor / You, derived from Brand config
 *   3. one cheap LLM call
 *   4. Other, if that call fails — never blocks collection
 */
import { BRANDS, DOMAIN_TYPE_SEEDS } from '../config'
import { DOMAIN_TYPES, type DomainType } from '../types'

export type ClassifiedBy = 'seed' | 'brand' | 'llm' | 'fallback'

const ENDPOINT = 'https://api.openai.com/v1/responses'
const MODEL = 'gpt-5-nano'

const brandDomainType = (domain: string): DomainType | null => {
  for (const brand of BRANDS) {
    if (brand.domains.includes(domain)) return brand.isSelf ? 'You' : 'Competitor'
  }
  return null
}

/**
 * D1 rejects a query with more than 100 bound parameters, and a day's sweep
 * cites far more Domains than that — 312 on 2026-07-30 — so the lookup runs in
 * chunks.
 */
const CHUNK = 100

/**
 * Far smaller than the D1 cap, because the two limits have nothing to do with
 * each other and sharing one constant broke classification. Asking for 100
 * Domains in one call never finished inside the 30s budget, so every backfill
 * failed and only the handful of Domains each sweep newly cited got through:
 * 280 sat unclassified while the backlog could never drain. Batches this size
 * answer in a few seconds.
 */
const LLM_BATCH = 25

/** Batches in flight at once, so draining a backlog stays inside the sweep's budget. */
const LLM_CONCURRENCY = 4

/** Classifies Domains not already stored, and records them permanently. */
export async function classifyNewDomains(db: D1Database, domains: string[], env: Cloudflare.Env): Promise<void> {
  const unique = [...new Set(domains)].filter((domain) => domain !== '')
  if (unique.length === 0) return

  const seen = await alreadyClassified(db, unique)
  const unclassified = unique.filter((domain) => !seen.has(domain))
  if (unclassified.length === 0) return

  const decided: { domain: string; type: DomainType; by: ClassifiedBy }[] = []
  const needsLlm: string[] = []

  for (const domain of unclassified) {
    const seeded = DOMAIN_TYPE_SEEDS[domain]
    if (seeded) {
      decided.push({ domain, type: seeded, by: 'seed' })
      continue
    }
    const fromBrand = brandDomainType(domain)
    if (fromBrand) {
      decided.push({ domain, type: fromBrand, by: 'brand' })
      continue
    }
    needsLlm.push(domain)
  }

  const batches: string[][] = []
  for (let start = 0; start < needsLlm.length; start += LLM_BATCH) {
    batches.push(needsLlm.slice(start, start + LLM_BATCH))
  }

  for (let start = 0; start < batches.length; start += LLM_CONCURRENCY) {
    const wave = batches.slice(start, start + LLM_CONCURRENCY)
    const guesses = await Promise.all(wave.map((batch) => classifyWithLlm(batch, env)))

    wave.forEach((batch, index) => {
      // A Domain Type is assigned once and then fixed, so a classifier that is
      // down must leave the Domain alone rather than freeze it as Other forever.
      // The next sweep picks it up again.
      const guessed = guesses[index]
      if (!guessed) return

      for (const domain of batch) {
        const type = guessed.get(domain)
        decided.push(type ? { domain, type, by: 'llm' } : { domain, type: 'Other', by: 'fallback' })
      }
    })
  }

  if (decided.length === 0) return

  const now = new Date().toISOString()
  await db.batch(
    decided.map((entry) =>
      db
        .prepare(
          `INSERT INTO domains (domain, domain_type, classified_by, classified_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(domain) DO NOTHING`,
        )
        .bind(entry.domain, entry.type, entry.by, now),
    ),
  )
}

/** Domains already carrying a Domain Type, looked up within D1's parameter cap. */
async function alreadyClassified(db: D1Database, domains: string[]): Promise<Set<string>> {
  const seen = new Set<string>()
  for (let start = 0; start < domains.length; start += CHUNK) {
    const chunk = domains.slice(start, start + CHUNK)
    const { results } = await db
      .prepare(`SELECT domain FROM domains WHERE domain IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk)
      .all<{ domain: string }>()
    for (const row of results) seen.add(row.domain)
  }
  return seen
}

/**
 * One cheap call for a batch of unseen Domains. Null means the call itself
 * failed, so the caller must leave those Domains for another sweep rather than
 * recording a guess it did not make.
 */
async function classifyWithLlm(domains: string[], env: Cloudflare.Env): Promise<Map<string, DomainType> | null> {
  // Competitor and You come from Brand config alone; the model cannot assign them.
  const types: DomainType[] = DOMAIN_TYPES.filter((type) => type !== 'Competitor' && type !== 'You')
  const result = new Map<string, DomainType>()

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        // Sorting Domains into six buckets needs no deliberation, and gpt-5-nano
        // reasons by default. Left unset it spent that budget on latency.
        reasoning: { effort: 'low' },
        instructions:
          `Classify each website domain into exactly one type: ${types.join(', ')}. ` +
          'Corporate = a company\'s own site. UGC = user-generated content and forums. ' +
          'Editorial = publications and blogs with editorial staff. Reference = documentation, wikis and standards. ' +
          'Institutional = government, education and non-profits. Other = anything else. ' +
          'Reply with JSON only: {"domain.com": "Type"}.',
        input: domains.join('\n'),
      }),
    })

    if (!response.ok) {
      console.error(`Domain classification failed: OpenAI ${response.status} ${(await response.text()).slice(0, 200)}`)
      return null
    }

    const body = (await response.json()) as {
      output?: { type?: string; content?: { type?: string; text?: string }[] }[]
    }
    const text = (body.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .map((content) => content.text ?? '')
      .join('')

    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, string>
    for (const [domain, type] of Object.entries(parsed)) {
      if (types.includes(type as DomainType)) result.set(domain, type as DomainType)
    }
    return result
  } catch (error) {
    // Classification is best-effort and must never lose a Run — but it stays
    // loud, because a silent catch here hid this being broken for a full day.
    console.error(`Domain classification failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
