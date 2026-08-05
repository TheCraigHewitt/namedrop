import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { BRANDS, PROMPTS, TOPICS } from '../src/lib/config'
import { getHtml, syncConfig } from './helpers'

describe('config sync', () => {
  it('loads every configured Topic, Prompt and Brand into D1', async () => {
    const response = await syncConfig()
    expect(response.status).toBe(200)

    const counts = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM topics WHERE active = 1) AS topics,
              (SELECT COUNT(*) FROM prompts WHERE active = 1) AS prompts,
              (SELECT COUNT(*) FROM brands WHERE active = 1) AS brands,
              (SELECT COUNT(*) FROM brand_aliases) AS aliases`,
    ).first<{ topics: number; prompts: number; brands: number; aliases: number }>()

    expect(counts).toMatchObject({
      topics: TOPICS.length,
      prompts: PROMPTS.length,
      brands: BRANDS.length,
    })
    expect(counts!.aliases).toBe(BRANDS.reduce((total, brand) => total + brand.aliases.length, 0))
  })

  it('is idempotent — a second sync leaves every row unchanged', async () => {
    await syncConfig()
    const before = await env.DB.prepare('SELECT id, topic_id, text, active FROM prompts ORDER BY id').all()

    await syncConfig()
    const after = await env.DB.prepare('SELECT id, topic_id, text, active FROM prompts ORDER BY id').all()

    expect(after.results).toEqual(before.results)
  })

  it('deactivates a Prompt dropped from config without deleting its history', async () => {
    await syncConfig()

    // Stands in for a Prompt we used to track: present in D1, absent from config.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO prompts (id, topic_id, text, active) VALUES ('retired-01', ?, 'Old question', 1)").bind(
        TOPICS[0]!.id,
      ),
      env.DB.prepare(
        `INSERT INTO runs (id, prompt_id, surface, run_date, created_at, status, response_text)
         VALUES ('run-old', 'retired-01', 'perplexity', '2026-07-01', '2026-07-01T07:00:00Z', 'ok', 'Castos is great')`,
      ),
    ])

    await syncConfig()

    const prompt = await env.DB.prepare("SELECT active FROM prompts WHERE id = 'retired-01'").first<{ active: number }>()
    expect(prompt?.active).toBe(0)

    const run = await env.DB.prepare("SELECT response_text FROM runs WHERE id = 'run-old'").first<{
      response_text: string
    }>()
    expect(run?.response_text).toBe('Castos is great')
  })

  it('renders the synced Prompts with their Topic on the dashboard', async () => {
    await syncConfig()

    const html = await getHtml('/prompts')

    expect(html).toContain('Podcast hosting platforms')
    expect(html).toContain(PROMPTS[0]!.text)
    expect(html).toContain(`${PROMPTS.length} active Prompts`)
  })

  it('renders every synced Brand on the Overview leaderboard', async () => {
    await syncConfig()

    const html = await getHtml('/')

    for (const brand of BRANDS) expect(html).toContain(brand.name)
  })
})
