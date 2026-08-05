import { beforeEach, describe, expect, it } from 'vitest'
import { parseCsv, parseCsvRows } from '../src/lib/csv'
import { get, getHtml, syncConfig } from './helpers'
import { rowFor } from './html'
import { seedRuns } from './seed'

const STRONG = 'podcast-hosting-platforms-01'
const WEAK = 'podcast-hosting-platforms-02'
const ANALYTICS = 'podcast-analytics-tools-01'

const FROM = '2026-07-20'
const TO = '2026-07-26'
const range = `from=${FROM}&to=${TO}`

const exportCsv = async (name: string, query = '') => {
  const response = await get(`/export/${name}.csv?${range}${query}`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/csv')
  return response.text()
}

beforeEach(async () => {
  await syncConfig()
  await seedRuns([
    {
      promptId: STRONG,
      surface: 'perplexity',
      date: '2026-07-20',
      responseText: 'Castos leads, then Transistor.',
      citations: ['https://castos.com/a', 'https://www.reddit.com/r/podcasting/x'],
      fanouts: ['best podcast hosting', 'castos review'],
    },
    {
      promptId: STRONG,
      surface: 'chatgpt',
      date: '2026-07-20',
      responseText: 'Castos is the best pick.',
      citations: ['https://old.reddit.com/r/podcasting/y'],
      fanouts: ['best podcast hosting'],
    },
    {
      promptId: WEAK,
      surface: 'perplexity',
      date: '2026-07-21',
      responseText: 'Transistor and Buzzsprout, then Castos.',
      citations: ['https://transistor.fm/'],
    },
    {
      promptId: ANALYTICS,
      surface: 'perplexity',
      date: '2026-07-22',
      responseText: 'Buzzsprout and Libsyn both work.',
    },
  ])

  await env_domains()
})

/** Domain Types as classification would have assigned them at ingest. */
async function env_domains() {
  const { env } = await import('cloudflare:workers')
  await env.DB.batch(
    [
      ['castos.com', 'You', 'brand'],
      ['reddit.com', 'UGC', 'seed'],
      ['transistor.fm', 'Competitor', 'seed'],
    ].map(([domain, type, by]) =>
      env.DB.prepare('INSERT INTO domains (domain, domain_type, classified_by, classified_at) VALUES (?, ?, ?, ?)').bind(
        domain,
        type,
        by,
        '2026-07-01T00:00:00Z',
      ),
    ),
  )
}

describe('prompts export', () => {
  it('mirrors the Peec prompts column shape', async () => {
    const csv = await exportCsv('prompts')

    expect(parseCsvRows(csv)[0]).toEqual([
      'status',
      'topic_id',
      'topic_name',
      'id',
      'prompt',
      'visibility',
      'visibility_delta',
      'sentiment',
      'sentiment_delta',
      'position',
      'position_delta',
      'mentions',
      'volume',
      'branding',
      'intent',
      'tags',
      'location',
      'share_of_voice',
      'share_of_voice_delta',
      'web_search',
      'web_search_delta',
      'added_at',
    ])
  })

  it('exports the same numbers the Prompts table shows', async () => {
    const rows = parseCsv(await exportCsv('prompts'))
    const strong = rows.find((row) => row.id === STRONG)!

    expect(strong).toMatchObject({
      status: 'active',
      topic_name: 'Podcast hosting platforms',
      visibility: '1.0000',
      position: '1.00',
      share_of_voice: '0.6667',
      mentions: 'Castos, Transistor',
      branding: 'non-branded',
    })

    // The dashboard renders the same underlying values.
    const html = await getHtml(`/prompts?${range}`)
    expect(rowFor(html, 'data-prompt', STRONG)).toMatchObject({
      visibility: '100.0%',
      position: '1.00',
      sov: '66.7%',
    })
  })

  it('leaves out-of-scope Peec columns empty rather than dropping them', async () => {
    const rows = parseCsv(await exportCsv('prompts'))
    const strong = rows.find((row) => row.id === STRONG)!

    expect(strong.sentiment).toBe('')
    expect(strong.tags).toBe('')
  })

  it('honours the Surface filter', async () => {
    const rows = parseCsv(await exportCsv('prompts', '&surface=chatgpt'))
    const weak = rows.find((row) => row.id === WEAK)!

    // The weak Prompt only ran on Perplexity, so ChatGPT has no Runs for it —
    // unmeasured, which the export leaves empty rather than calling it 0%.
    expect(weak.visibility).toBe('')
    expect(weak.mentions).toBe('')
  })

  it('leaves a Prompt with no Runs empty rather than reporting zero Visibility', async () => {
    const rows = parseCsv(await exportCsv('prompts'))
    const unmeasured = rows.find((row) => row.id === 'podcast-monetization-01')!

    // The Prompts table shows an em dash for these; the export must agree.
    expect(unmeasured).toMatchObject({ visibility: '', visibility_delta: '', share_of_voice: '', position: '' })
  })
})

describe('domains export', () => {
  it('mirrors the Peec gap-domains shape with counts and rates', async () => {
    const csv = await exportCsv('domains')
    const rows = parseCsv(csv)

    expect(parseCsvRows(csv)[0]).toEqual([
      'domain',
      'domain_type',
      'retrieved',
      'retrieval_rate',
      'citation_rate',
      'citation_rate_delta',
      'gap_score',
    ])

    // reddit.com cited twice across 4 Runs, in 2 of them.
    expect(rows.find((row) => row.domain === 'reddit.com')).toMatchObject({
      domain_type: 'UGC',
      retrieved: '2',
      retrieval_rate: '0.5000',
      gap_score: '',
    })
    expect(rows.find((row) => row.domain === 'castos.com')?.domain_type).toBe('You')
  })
})

describe('top rankings export', () => {
  it('ranks Brands by Visibility for each Surface', async () => {
    const rows = parseCsvRows(await exportCsv('top-rankings'))

    expect(rows[0]!.slice(0, 3)).toEqual(['AI models', '#1', '#2'])

    const chatgpt = rows.find((row) => row[0] === 'ChatGPT')!
    // Only the ChatGPT Run mentions Castos alone.
    expect(chatgpt[1]).toBe('Castos')

    // On Perplexity, Castos, Transistor and Buzzsprout each appear in 2 of 3
    // Runs, so they tie and fall back to alphabetical order ahead of the rest.
    const perplexity = rows.find((row) => row[0] === 'Perplexity')!
    expect(perplexity.slice(1, 4)).toEqual(['Buzzsprout', 'Castos', 'Transistor'])
    expect(perplexity[4]).toBe('Libsyn')
  })
})

describe('performance matrix export', () => {
  it('reports Visibility by Prompt tag against Topic', async () => {
    const rows = parseCsvRows(await exportCsv('performance-matrix'))

    expect(rows[0]![0]).toBe('Tags')
    expect(rows[0]).toContain('Podcast hosting platforms')

    const hostingColumn = rows[0]!.indexOf('Podcast hosting platforms')
    const nonBranded = rows.find((row) => row[0] === 'non-branded')!
    // 3 hosting Runs, Castos mentioned in all 3.
    expect(nonBranded[hostingColumn]).toBe('100.0%')
  })
})

describe('fanouts export', () => {
  it('reports what each Surface searched for, most frequent first', async () => {
    const csv = await exportCsv('fanouts')
    const rows = parseCsv(csv)

    expect(parseCsvRows(csv)[0]).toEqual(['Model', 'Query', 'Type', 'Occurrences'])
    expect(rows[0]).toMatchObject({ Query: 'best podcast hosting', Type: 'search', Occurrences: '1' })
    expect(rows.map((row) => row.Query)).toContain('castos review')
    expect(rows.map((row) => row.Model)).toContain('Perplexity')
  })

  it('honours the Surface filter', async () => {
    const rows = parseCsv(await exportCsv('fanouts', '&surface=chatgpt'))

    expect(rows.every((row) => row.Model === 'ChatGPT')).toBe(true)
    expect(rows.map((row) => row.Query)).toEqual(['best podcast hosting'])
  })
})
