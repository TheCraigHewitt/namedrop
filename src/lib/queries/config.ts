/** Reads of the config-derived tables, as synced into D1. */

export interface BrandRow {
  id: string
  name: string
  is_self: number
  active: number
}

export interface PromptRow {
  id: string
  topic_id: string
  topic_name: string
  text: string
  intent: string | null
  branding: string | null
}

export async function listBrands(db: D1Database): Promise<BrandRow[]> {
  const { results } = await db
    .prepare('SELECT id, name, is_self, active FROM brands WHERE active = 1 ORDER BY is_self DESC, name')
    .all<BrandRow>()
  return results
}

export async function listTopics(db: D1Database): Promise<{ id: string; name: string }[]> {
  const { results } = await db
    .prepare('SELECT id, name FROM topics WHERE active = 1 ORDER BY name')
    .all<{ id: string; name: string }>()
  return results
}

export async function listActivePrompts(db: D1Database): Promise<PromptRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.topic_id, t.name AS topic_name, p.text, p.intent, p.branding
       FROM prompts p
       JOIN topics t ON t.id = p.topic_id
       WHERE p.active = 1
       ORDER BY t.name, p.id`,
    )
    .all<PromptRow>()
  return results
}

/** Groups Prompts under their Topic, preserving the query's ordering. */
export function groupByTopic(prompts: PromptRow[]): { id: string; name: string; prompts: PromptRow[] }[] {
  const topics = new Map<string, { id: string; name: string; prompts: PromptRow[] }>()
  for (const prompt of prompts) {
    let topic = topics.get(prompt.topic_id)
    if (!topic) {
      topic = { id: prompt.topic_id, name: prompt.topic_name, prompts: [] }
      topics.set(prompt.topic_id, topic)
    }
    topic.prompts.push(prompt)
  }
  return [...topics.values()]
}
