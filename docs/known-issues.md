# Known issues and recurring traps

Failure modes the original deployment of this project actually hit, what they
looked like, and what fixed them. Most of them looked like something else
first.

## The D1 100-parameter cap

**D1 rejects any query with more than 100 bound parameters.** This has broken
three separate things, and it will break a fourth. Any time a query builds
`IN (?, ?, …)` from an array, ask how large that array gets on a real day — a
day of collection at 48 Prompts is ~144 Runs and cites 300+ Domains.

Symptoms: `D1_ERROR: too many SQL variables`, or a 500 with an empty body, or —
worst — a silent `.catch()` that hides it.

| Where | Result |
|---|---|
| `classify.ts` — Domain lookup | Domain classification never worked at all until it was found |
| `runs.ts` — `decorate()` | `/runs` 500d on any window over 100 Runs |
| `sync.ts` — `deactivateMissing()` | **Still latent.** Breaks if Prompts, Topics or Brands ever exceed 100 |

The `sync.ts` one is deliberately unfixed: it uses `NOT IN`, where chunking
would change the meaning rather than preserve it — a row absent from chunk 1 but
present in chunk 2 would be wrongly deactivated. It needs a different approach
(temp table, or an anti-join), not the chunking used elsewhere. Safe below 100
Prompts.

**Why the tests missed it twice:** they seeded a handful of Runs where
production produces hundreds. Tests that exercise a page or query must seed
past 100 rows, or they are testing a case that never occurs in production.

## Time limits, and which one you are hitting

Four different limits cut collection off, and they look similar from the
outside.

| Limit | Value | Applies to |
|---|---|---|
| Cron Trigger wall clock | 15 min | The daily crons |
| Cloudflare request cut-off | ~360s | `/api/sweep`, `/api/calibrate` |
| Node undici header timeout | 300s | `npm run sweep` (now disabled in the script) |
| Per-call `AbortSignal.timeout` | 120s | One provider call |

Consequences:

- **One Surface per cron.** All three in one firing does not fit in 15 minutes.
  `SURFACE_BY_CRON` in `src/worker.ts` maps each schedule to its Surface and must
  stay in step with `triggers.crons` in `wrangler.jsonc`. A schedule missing from
  that map collects nothing, silently.
- **A manual ChatGPT sweep cannot finish in one request.** It needs longer than
  Cloudflare will hold a request. Use `--resume` and expect to run it two or
  three times. See [deploy.md](deploy.md#chatgpt-needs-more-than-one-call).
- **The Worker is killed when the client disconnects.** A sweep does not carry
  on in the background. The original deployment lost 18 of 48 Prompts — and the
  money spent on them — when the sweep script's own 300s timeout abandoned a
  sweep mid-collection.

## Failure must never destroy success

`storeFailedRun` originally cleared the existing Run before inserting the
failed one. A re-run that hit `insufficient_quota` on every Prompt then
**destroyed that morning's successful Runs.** Recovered with D1 Time Travel.

The rule now enforced in `sweep.ts`: a failed Run never replaces a Run that
already succeeded for the same date. A successful Run *does* replace a failed
one, which is what makes `--resume` work.

**Recovery:** D1 Time Travel keeps 30 days.

```sh
npx wrangler d1 time-travel restore namedrop --timestamp=2026-07-30T14:58:00Z
```

Pick a timestamp *after* the most recent schema migration, or the restore rolls
the schema back too.

## Silent failure is the real enemy

Two bugs here ran for days because their errors were swallowed:

- Domain classification had a bare `.catch(() => {})`. It had never worked in
  production and nothing said so.
- The sweep's counts were only written at the end, so a truncated sweep
  reported nothing about what it had done.

Now: classification failures log loudly, sweep counts are written per Run as
they land, and collection health reads **Runs** rather than sweep rows, so a
Surface that goes dark is named on the dashboard rather than averaged away.

## Sizing a batch to the wrong limit

Domain classification chunked at 100 because that is D1's parameter cap — but
the same 100 was handed to the LLM, and a call that size never returned inside
its 30s budget. Every backfill failed; only the few Domains each sweep newly
cited got through, and the backlog grew to hundreds with no way to drain.

The two limits are unrelated. `CHUNK = 100` is for D1; `LLM_BATCH = 25` is for
the model. Fixing it cleared a 200-Domain backlog in under half a minute.

## Cloudflare Access

Access is the only thing protecting this app — there is no auth code. An
uncovered hostname serves the whole dashboard against the production database.

- A **service token must sit on a `Service Auth` policy**, not in the Include
  list of an `Allow` policy. The latter looks correct and never works, because
  `Allow` requires an interactive login.
- **HTML where JSON was expected means Access rejected you**, not that the
  request failed. Access serves its login page with a 200.
- **A 502 does not mean Access.** It means the request was cut off. The sweep
  script used to report every HTML response as an auth failure, which sent a
  debugging session chasing the service token while the sweep was really being
  truncated.
- `preview_urls: false` stops new preview hostnames being created but does not
  retract existing ones.

## Surface mix quietly moves the numbers

Metrics pool Runs across Surfaces (`scope.ts` excludes failed Runs). When one
Surface goes dark, the aggregate silently re-weights toward the others and the
trend line moves for reasons unrelated to actual visibility.

The original deployment measured this directly: on a day ChatGPT collected
nothing, the self Brand's aggregate Visibility *rose*, purely because the
Surface where it scored lowest had dropped out of the pool. Per-Surface
Visibility rates differ enough for this to matter on any deployment, and the
more the rates diverge, the bigger the phantom moves.

**Unfixed.** The cheap mitigation is to flag days with incomplete Surface
coverage on charts. The correct fix is to compute aggregate Visibility as the
mean of per-Surface rates rather than pooled Runs, so a missing Surface drops
out instead of re-weighting.

## Open items

- `sync.ts` `NOT IN` parameter cap — latent, breaks above 100 Prompts.
- Surface-mix bias in aggregate Visibility — above.
- Discontinuities: any settings, model or mechanism change makes windows that
  straddle it blend non-comparable Runs — see [costs.md](costs.md). The Run's
  `model` column says which era it is.
- ChatGPT collection depends on cloro.dev, a third party scraping chatgpt.com.
  If it goes dark, the Health page shows ChatGPT failing; the fallback is the
  API path still living in `chatgpt.ts` for `/api/calibrate`. **Never point
  collection at a free-tier cloro key**: 1 concurrent job puts a full sweep
  past the Cron Trigger's 15-minute cap.
- Per-Prompt reads are noisier than the aggregate: run-to-run Brand-set
  agreement varies by model, and a model change can make single-day per-Prompt
  reads markedly less trustworthy while the rolling window stays fine.
