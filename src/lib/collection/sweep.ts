/**
 * The daily sweep: every active Prompt against one Surface, once per day.
 *
 * A Run is one Prompt on one Surface on one date, so its id is derived from
 * those three — re-running a day overwrites that day's Runs rather than
 * duplicating them. One Prompt failing never aborts the sweep; it lands as a
 * failed Run so the hole in the data is visible.
 *
 * One Surface per sweep, because a Cron Trigger is killed at 15 minutes of wall
 * clock. All three Surfaces in one firing did not fit — ChatGPT alone averages
 * ~84s per Prompt — and the Surface that sorted last simply never ran. Each
 * Surface now collects on its own schedule with its own budget.
 */
import { BRANDS } from '../config'
import { registrableDomain } from '../domain'
import { classifyNewDomains } from '../domains/classify'
import { detectMentions } from '../mentions'
import type { SurfaceAdapter, SurfaceId, SurfaceResponse } from '../types'

/** Concurrent provider calls in flight. 48 Prompts at ChatGPT's ~84s average finishes in ~9 of the 15 minutes. */
const CONCURRENCY = 8
const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 1000

/**
 * Long enough to sit above ChatGPT's own latency, not just in the middle of it:
 * at 90s it was cutting off 14 of 48 Prompts whose successful siblings averaged
 * 84s. A timed-out call is billed either way, so completing it turns spend that
 * was happening anyway into a stored Run.
 *
 * The ceiling is the sweep's budget: 48 Prompts all taking the full timeout is
 * 48 × 120s ÷ 8 in flight = 12 minutes, inside the Cron Trigger's 15-minute cap.
 * 150s would not fit.
 */
const CALL_TIMEOUT_MS = 120_000

export interface SweepOptions {
  /** Collection date (YYYY-MM-DD, UTC). Defaults to today. */
  date?: string
  /** Overridable so tests do not sit through backoff. */
  retryDelayMs?: number
  /**
   * Skip Prompts that already have a successful Run for the date, so a sweep
   * that died part-way can be finished without re-buying what it did collect.
   * Off by default: re-running a date normally means collecting it afresh.
   */
  resume?: boolean
}

export interface SweepResult {
  sweepId: string
  date: string
  surface: SurfaceId
  ok: number
  failed: number
  status: 'ok' | 'partial' | 'failed'
}

interface PromptRow {
  id: string
  text: string
}

export const runId = (date: string, surface: string, promptId: string) => `${date}:${surface}:${promptId}`

export const utcDate = (at: Date = new Date()) => at.toISOString().slice(0, 10)

export async function runSweep(env: Cloudflare.Env, adapter: SurfaceAdapter, options: SweepOptions = {}): Promise<SweepResult> {
  const date = options.date ?? utcDate()
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS

  // Before collecting, not after: classification is the one step a truncated
  // sweep drops, so the next sweep is what repairs it.
  await backfillUnclassifiedDomains(env)

  const { results: allPrompts } = await env.DB.prepare('SELECT id, text FROM prompts WHERE active = 1 ORDER BY id').all<PromptRow>()
  const prompts = options.resume ? await withoutCollected(env.DB, allPrompts, date, adapter.surface) : allPrompts

  const sweepId = `${date}:${adapter.surface}:${crypto.randomUUID().slice(0, 8)}`
  const startedAt = new Date().toISOString()
  await env.DB.prepare('INSERT INTO sweeps (id, started_at, status, surface) VALUES (?, ?, ?, ?)')
    .bind(sweepId, startedAt, 'running', adapter.surface)
    .run()

  let ok = 0
  let failed = 0

  const citedDomains = new Set<string>()

  await pooled(prompts, CONCURRENCY, async (prompt) => {
    try {
      const startedAtMs = Date.now()
      const response = await withRetry(() => callAdapter(adapter, prompt.text, env), retryDelayMs)
      const domains = await storeRun(env.DB, {
        sweepId,
        date,
        promptId: prompt.id,
        surface: adapter.surface,
        response,
        durationMs: Date.now() - startedAtMs,
      })
      for (const domain of domains) citedDomains.add(domain)
      ok++
    } catch (error) {
      await storeFailedRun(env.DB, {
        sweepId,
        date,
        promptId: prompt.id,
        surface: adapter.surface,
        error: error instanceof Error ? error.message : String(error),
      })
      failed++
    }
  })

  // Classify once per sweep rather than per Run: concurrent Runs citing the same
  // new Domain would otherwise each pay for their own classification call.
  // Failure here must never lose the Runs already stored, but it must be loud.
  await classifyNewDomains(env.DB, [...citedDomains], env).catch(logClassificationFailure)

  const status: SweepResult['status'] = failed === 0 ? 'ok' : ok === 0 ? 'failed' : 'partial'
  // Counts were written as each Run landed, so only the outcome is left to record.
  await env.DB.prepare('UPDATE sweeps SET completed_at = ?, status = ? WHERE id = ?')
    .bind(new Date().toISOString(), status, sweepId)
    .run()

  return { sweepId, date, surface: adapter.surface, ok, failed, status }
}

/**
 * The Prompts still needing collection for a date, filtered in memory because
 * D1 caps a query at 100 bound parameters and there are more Prompts than that
 * in reach.
 */
async function withoutCollected(db: D1Database, prompts: PromptRow[], date: string, surface: SurfaceId): Promise<PromptRow[]> {
  const { results } = await db
    .prepare("SELECT prompt_id FROM runs WHERE run_date = ? AND surface = ? AND status = 'ok'")
    .bind(date, surface)
    .all<{ prompt_id: string }>()

  const collected = new Set(results.map((row) => row.prompt_id))
  return prompts.filter((prompt) => !collected.has(prompt.id))
}

/**
 * Domains cited by earlier Runs that were never classified. Classification only
 * happens once a sweep's pool drains, so a sweep that is cut short leaves its
 * Domains unclassified and the Sources view missing their Domain Type.
 */
async function backfillUnclassifiedDomains(env: Cloudflare.Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT s.domain
     FROM sources s
     LEFT JOIN domains d ON d.domain = s.domain
     WHERE d.domain IS NULL`,
  ).all<{ domain: string }>()

  if (results.length === 0) return
  await classifyNewDomains(
    env.DB,
    results.map((row) => row.domain),
    env,
  ).catch(logClassificationFailure)
}

/** Classification never blocks collection, but a silent catch here hid it being broken for a full day. */
const logClassificationFailure = (error: unknown) =>
  console.error(`Domain classification pass failed: ${error instanceof Error ? error.message : String(error)}`)

async function callAdapter(adapter: SurfaceAdapter, promptText: string, env: Cloudflare.Env): Promise<SurfaceResponse> {
  // A Surface that never answers must not hold the whole sweep open.
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS)
  return adapter.run(promptText, env, timeout)
}

/**
 * A call that ran out of time is not worth a second attempt: the retry costs
 * another full timeout of the sweep's budget and, on the Runs that hit this in
 * production, timed out again every time.
 */
const isRetryable = (error: unknown): boolean => {
  const name = (error as { name?: string } | null | undefined)?.name
  return name !== 'TimeoutError' && name !== 'AbortError'
}

async function withRetry<T>(operation: () => Promise<T>, delayMs: number): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) break
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

/** Runs tasks with a fixed number in flight. */
async function pooled<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!
      await task(item)
    }
  })
  await Promise.all(workers)
}

export interface StoreRunInput {
  sweepId: string | null
  date: string
  promptId: string
  surface: SurfaceId
  response: SurfaceResponse
  /** Wall-clock of the provider call, for seeing how close Runs came to the timeout. */
  durationMs?: number
}

/**
 * Writes one collected Run and everything hanging off it.
 * Returns the Domains it cited, so the caller can classify new ones.
 */
export async function storeRun(db: D1Database, input: StoreRunInput): Promise<string[]> {
  const id = runId(input.date, input.surface, input.promptId)
  const mentions = detectMentions(input.response.answerText, BRANDS)

  const statements: D1PreparedStatement[] = [
    ...clearRun(db, id),
    db
      .prepare(
        `INSERT INTO runs (id, sweep_id, prompt_id, surface, run_date, created_at, status, model, response_text,
                           input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.sweepId,
        input.promptId,
        input.surface,
        input.date,
        new Date().toISOString(),
        input.response.model,
        input.response.answerText,
        input.response.usage?.inputTokens ?? null,
        input.response.usage?.outputTokens ?? null,
        input.response.usage?.reasoningTokens ?? null,
        input.response.usage?.cachedInputTokens ?? null,
        input.durationMs ?? null,
      ),
    ...countRun(db, input.sweepId, 'ok_count'),
  ]

  for (const mention of mentions) {
    statements.push(
      db
        .prepare('INSERT INTO mentions (run_id, brand_id, position, first_index, mention_count) VALUES (?, ?, ?, ?, ?)')
        .bind(id, mention.brandId, mention.position, mention.firstIndex, mention.count),
    )
  }

  const domains: string[] = []
  input.response.citations.forEach((citation, index) => {
    // An adapter that knows the real Domain overrides the URL, which may be a
    // provider redirect rather than the source itself.
    const domain = citation.domain ?? registrableDomain(citation.url)
    if (!domain) return
    domains.push(domain)
    statements.push(
      db
        .prepare('INSERT INTO sources (run_id, ordinal, url, domain, title) VALUES (?, ?, ?, ?, ?)')
        .bind(id, index, citation.url, domain, citation.title ?? null),
    )
  })

  input.response.fanouts.forEach((query, index) => {
    statements.push(db.prepare('INSERT INTO fanouts (run_id, ordinal, query) VALUES (?, ?, ?)').bind(id, index, query))
  })

  await db.batch(statements)
  return domains
}

/**
 * Records a Prompt this sweep could not collect.
 *
 * A failure never replaces a Run that already succeeded for the same date. Only
 * a success is worth overwriting a success with — re-running a date against a
 * provider that has since broken would otherwise destroy the very day it was
 * meant to repair, which is exactly what an exhausted OpenAI quota did on
 * 2026-07-30. The sweep still counts it as failed, because the sweep did fail.
 */
async function storeFailedRun(
  db: D1Database,
  input: { sweepId: string; date: string; promptId: string; surface: SurfaceId; error: string },
): Promise<void> {
  const id = runId(input.date, input.surface, input.promptId)
  await db.batch([
    db.prepare("DELETE FROM runs WHERE id = ? AND status = 'failed'").bind(id),
    db
      .prepare(
        `INSERT INTO runs (id, sweep_id, prompt_id, surface, run_date, created_at, status, error)
         SELECT ?, ?, ?, ?, ?, ?, 'failed', ?
         WHERE NOT EXISTS (SELECT 1 FROM runs WHERE id = ?)`,
      )
      .bind(id, input.sweepId, input.promptId, input.surface, input.date, new Date().toISOString(), input.error.slice(0, 500), id),
    ...countRun(db, input.sweepId, 'failed_count'),
  ])
}

/**
 * Counts a Run against its sweep as it lands, in the same batch that stores it.
 * A sweep killed at the Cron Trigger's 15-minute cap never reaches its final
 * update, so counts held in memory until then are lost with it.
 */
function countRun(db: D1Database, sweepId: string | null, column: 'ok_count' | 'failed_count'): D1PreparedStatement[] {
  if (sweepId === null) return []
  return [db.prepare(`UPDATE sweeps SET ${column} = ${column} + 1 WHERE id = ?`).bind(sweepId)]
}

/** Re-running a date replaces that date's Run and everything hanging off it. */
function clearRun(db: D1Database, id: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM mentions WHERE run_id = ?').bind(id),
    db.prepare('DELETE FROM sources WHERE run_id = ?').bind(id),
    db.prepare('DELETE FROM fanouts WHERE run_id = ?').bind(id),
    db.prepare('DELETE FROM runs WHERE id = ?').bind(id),
  ]
}
