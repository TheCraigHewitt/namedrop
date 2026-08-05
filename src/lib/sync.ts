/**
 * Reconciles the versioned config files into D1. Idempotent: re-running with an
 * unchanged config is a no-op. Anything dropped from config is deactivated, never
 * deleted, so Runs collected against it stay queryable.
 */
import { BRANDS, PROMPTS, TOPICS } from './config'

export interface SyncResult {
  topics: number
  prompts: number
  brands: number
  deactivatedPrompts: number
  deactivatedTopics: number
  deactivatedBrands: number
}

export async function syncConfig(db: D1Database): Promise<SyncResult> {
  const statements: D1PreparedStatement[] = []

  for (const topic of TOPICS) {
    statements.push(
      db
        .prepare(
          `INSERT INTO topics (id, name, active) VALUES (?, ?, 1)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = 1`,
        )
        .bind(topic.id, topic.name),
    )
  }

  for (const prompt of PROMPTS) {
    statements.push(
      db
        .prepare(
          `INSERT INTO prompts (id, topic_id, text, intent, branding, active) VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(id) DO UPDATE SET
             topic_id = excluded.topic_id,
             text = excluded.text,
             intent = excluded.intent,
             branding = excluded.branding,
             active = 1`,
        )
        .bind(prompt.id, prompt.topicId, prompt.text, prompt.intent ?? null, prompt.branding ?? null),
    )
  }

  for (const brand of BRANDS) {
    statements.push(
      db
        .prepare(
          `INSERT INTO brands (id, name, is_self, active) VALUES (?, ?, ?, 1)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_self = excluded.is_self, active = 1`,
        )
        .bind(brand.id, brand.name, brand.isSelf ? 1 : 0),
    )
    // Aliases and domains are small, config-owned sets with no history of their
    // own, so replacing them wholesale keeps removals correct.
    statements.push(db.prepare('DELETE FROM brand_aliases WHERE brand_id = ?').bind(brand.id))
    for (const alias of brand.aliases) {
      statements.push(
        db
          .prepare('INSERT INTO brand_aliases (brand_id, alias, not_followed_by) VALUES (?, ?, ?)')
          .bind(brand.id, alias.text, alias.notFollowedBy.length ? JSON.stringify(alias.notFollowedBy) : null),
      )
    }
    statements.push(db.prepare('DELETE FROM brand_domains WHERE brand_id = ?').bind(brand.id))
    for (const domain of brand.domains) {
      statements.push(db.prepare('INSERT INTO brand_domains (brand_id, domain) VALUES (?, ?)').bind(brand.id, domain))
    }
  }

  statements.push(deactivateMissing(db, 'prompts', PROMPTS.map((p) => p.id)))
  statements.push(deactivateMissing(db, 'topics', TOPICS.map((t) => t.id)))
  statements.push(deactivateMissing(db, 'brands', BRANDS.map((b) => b.id)))

  const results = await db.batch(statements)
  const [prompts, topics, brands] = results.slice(-3)

  return {
    topics: TOPICS.length,
    prompts: PROMPTS.length,
    brands: BRANDS.length,
    deactivatedPrompts: prompts?.meta.changes ?? 0,
    deactivatedTopics: topics?.meta.changes ?? 0,
    deactivatedBrands: brands?.meta.changes ?? 0,
  }
}

/** Table names are literals from this module, never user input. */
function deactivateMissing(db: D1Database, table: 'prompts' | 'topics' | 'brands', keepIds: string[]): D1PreparedStatement {
  const placeholders = keepIds.map(() => '?').join(', ')
  return db
    .prepare(`UPDATE ${table} SET active = 0 WHERE active = 1 AND id NOT IN (${placeholders})`)
    .bind(...keepIds)
}
