import { env } from 'cloudflare:workers'
import { runId, storeRun } from '../src/lib/collection/sweep'
import type { SurfaceId } from '../src/lib/types'

/**
 * Seeds Runs across many dates, for tests about metrics over history rather
 * than about one day's collection.
 *
 * It writes through the same `storeRun` the sweep uses, so seeded rows are
 * exactly what collection would have produced — Mentions are detected from the
 * Response text by the real detector, Sources roll up to real Domains. Only the
 * provider call is skipped, and its output is supplied here instead.
 *
 * Tests about collection itself drive the cron handler; see `runCron`.
 */
export interface SeedRun {
  promptId: string
  surface: SurfaceId
  date: string
  /** Omit for a failed Run. */
  responseText?: string
  citations?: string[]
  fanouts?: string[]
  error?: string
  /** When the Run was collected. Defaults to 07:00 UTC on its own date. */
  createdAt?: string
}

export async function seedRuns(runs: SeedRun[]): Promise<void> {
  for (const run of runs) {
    if (run.responseText === undefined) {
      await seedFailedRun(run)
      continue
    }

    await storeRun(env.DB, {
      sweepId: null,
      date: run.date,
      promptId: run.promptId,
      surface: run.surface,
      response: {
        answerText: run.responseText,
        model: 'sonar',
        citations: (run.citations ?? []).map((url) => ({ url })),
        fanouts: run.fanouts ?? [],
      },
    })

    // `storeRun` stamps a Run as collected now, which is right in a sweep and
    // wrong for seeded history — collection health reads how long ago a Surface
    // last managed a Run.
    await env.DB.prepare('UPDATE runs SET created_at = ? WHERE id = ?')
      .bind(createdAtOf(run), runId(run.date, run.surface, run.promptId))
      .run()
  }
}

const createdAtOf = (run: SeedRun) => run.createdAt ?? `${run.date}T07:00:00Z`

async function seedFailedRun(run: SeedRun): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (id, prompt_id, surface, run_date, created_at, status, error)
     VALUES (?, ?, ?, ?, ?, 'failed', ?)`,
  )
    .bind(runId(run.date, run.surface, run.promptId), run.promptId, run.surface, run.date, createdAtOf(run), run.error ?? 'seeded failure')
    .run()
}
