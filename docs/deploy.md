# Deploy and access

One Cloudflare Worker serves the Astro dashboard, the CSV exports, and the daily
collection crons. Storage is D1. Auth is Cloudflare Access in front of the Worker —
there is no auth code in the app.

The dashboard lives at `https://<worker-name>.<your-team>.workers.dev` (the
examples below use `namedrop.your-team.workers.dev`) and stays there.
There is deliberately no custom domain, so that `workers.dev` hostname is the
one route Access has to cover.

Collection is split across three Cron Triggers, one per Surface (07:00, 07:20 and
07:40 UTC). A Cron Trigger is killed at 15 minutes of wall clock, and all three
Surfaces in one firing does not fit. `SURFACE_BY_CRON` in `src/worker.ts` maps
each schedule to its Surface and must stay in step with `triggers.crons` in
`wrangler.jsonc` — a schedule missing from that map collects nothing.

07:00 UTC is deliberate: it is the middle of the US night, and provider latency
is markedly worse during US business hours. There is no off-peak *pricing*, but a
call that times out is billed in full and stored as nothing, so latency is a cost
question. See [costs.md](costs.md).

## One-time setup

These steps need your Cloudflare account, so they are manual.

1. **Create the D1 database** and paste the returned `database_id` into
   `wrangler.jsonc` (replacing `PLACEHOLDER_SET_BY_WRANGLER_D1_CREATE`):

   ```sh
   npx wrangler d1 create namedrop
   ```

2. **Apply migrations** to the remote database:

   ```sh
   npm run db:migrate:remote
   ```

3. **Set the provider secrets** (never committed; `.dev.vars` covers local dev):

   ```sh
   npx wrangler secret put PERPLEXITY_API_KEY
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put CLORO_API_KEY
   ```

   On the first one, before the Worker has ever been deployed, wrangler asks
   whether to create a Worker of that name. Answer yes: it creates an empty
   placeholder with no code, no bindings and no route, and the deploy in the
   next step uploads the real code over it. Secrets belong to the Worker rather
   than to a deployment, so they survive that and every later deploy.

   `CLORO_API_KEY` collects the ChatGPT Surface (a real chatgpt.com session via
   cloro.dev) and **must belong to a paid Lite-or-above plan** — the free tier's
   single concurrent job puts a sweep past the cron's 15-minute cap.
   `OPENAI_API_KEY` covers the Domain classifier and `/api/calibrate`.

4. **Deploy**:

   ```sh
   npm run deploy
   ```

5. **Put Cloudflare Access in front of the Worker** (Zero Trust dashboard →
   Access → Applications → Add a self-hosted application):
   - Domain: `namedrop.your-team.workers.dev`.
   - Policy 1 — humans: action *Allow*, include *Emails ending in*
     `@your-team.example` (or an explicit email list).
   - Policy 2 — scripts: action *Service Auth*, include the service token created
     in the next step. Service Auth policies must be listed above Allow policies.

   **Access must cover every hostname the Worker answers on.** It is the only
   thing protecting this app — there is no auth check in the code — and an
   uncovered hostname serves the whole dashboard against the production
   database. In particular:
   - `preview_urls: false` in `wrangler.jsonc` stops new per-version preview
     hostnames being created, but does not retract one that already exists.
     Retract those under Workers → the Worker → Settings → Preview URLs.
   - The `workers.dev` route is the only route, so add a second Access
     application for `*.namedrop.your-team.workers.dev` to catch any
     preview hostname that already exists.

6. **Attach a service token** for any script or downstream tool that reads the
   exports (Zero Trust → Access → Service Auth → Service Tokens). Save the
   Client ID and Client Secret into that consumer's environment as
   `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. A new token's secret is
   shown once.

   The policy holding the token must have the action `Service Auth`. A service
   token added to the Include of an `Allow` policy looks correct and never
   works, because `Allow` requires an interactive login. See
   [docs/exports.md](exports.md) for how to tell the two apart from a 302.

7. **Sync config to the deployed database** (also runs automatically on every
   `npm run deploy` once these are set):

   ```sh
   DASHBOARD_URL=https://namedrop.your-team.workers.dev \
   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... npm run sync
   ```

## Verifying the first sweep

Collection runs from 07:00 UTC, finishing by ~07:55. The Health page is the first
place to look: it reports coverage per Surface, so a Surface that collected
nothing reads as stale rather than as a sparse Overview. A bad API key shows up
there as failed Runs.

For a per-Surface breakdown, which is what catches an adapter parsing a real
response differently from its fixture:

```sh
npx wrangler d1 execute namedrop --remote --command "
SELECT r.surface,
       COUNT(*) AS runs,
       SUM(r.status='ok') AS ok,
       SUM(r.status='failed') AS failed,
       (SELECT COUNT(*) FROM sources s JOIN runs r2 ON r2.id=s.run_id WHERE r2.surface=r.surface) AS sources,
       (SELECT COUNT(*) FROM fanouts f JOIN runs r3 ON r3.id=f.run_id WHERE r3.surface=r.surface) AS fanouts,
       (SELECT COUNT(*) FROM mentions m JOIN runs r4 ON r4.id=m.run_id WHERE r4.surface=r.surface) AS mentions
FROM runs r GROUP BY r.surface ORDER BY r.surface"
```

What good looks like, and what each failure means (counts assume every active
Prompt collected):

| Reading | Meaning |
| --- | --- |
| one `ok` per Prompt per Surface | collection is working |
| a Surface missing entirely | its cron did not fire, or maps to no Surface in `SURFACE_BY_CRON` |
| a Surface all `failed` | bad key, wrong model name, or the API changed — the error is on the Health page |
| `failed` with `timeout` errors | that Surface is slower than `CALL_TIMEOUT_MS`; timeouts are not retried |
| `ok` Runs but `sources` 0 for one Surface | that adapter's citation extraction no longer matches the real response |
| `fanouts` 0 for Perplexity | expected — Sonar does not report the searches it ran |
| `fanouts` 0 for ChatGPT and Gemini | those adapters' Fanout extraction has drifted |
| `mentions` 0 everywhere | alias matching is broken, not that nobody was mentioned |

A Surface whose Sources or Fanouts come back empty is the signal to re-record
that provider's fixture from a real response and re-check the adapter against it.

A sweep shown as `truncated` on the Health page ran past the 15-minute cap and
was killed part-way. Its counts are still accurate — they are written as each Run
lands — but the rest of that Surface's Prompts never ran. Re-run the date.

## Re-running a date

Cron is the normal trigger. To backfill a date the schedule lost, call the
deployed Worker — it holds the provider keys, and re-running replaces that date's
Runs rather than duplicating them:

```sh
DASHBOARD_URL=https://namedrop.your-team.workers.dev \
CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
  npm run sweep -- --date 2026-07-30
```

Add `--surface chatgpt` to re-run one Surface. The script walks the Surfaces
sequentially and each request stays open for the several minutes its sweep takes.

### ChatGPT needs more than one call

Cloudflare cuts a request off around six minutes, and a full ChatGPT sweep can
need more, so a manual ChatGPT re-run may stop part-way with a 502. The Runs it
collected are saved; `--resume` collects only the Prompts with no successful
Run for that date, so repeating the command finishes the day without paying for
the Runs already in hand:

```sh
DASHBOARD_URL=... npm run sweep -- --surface chatgpt --date 2026-07-31 --resume
```

Expect to run it two or three times on a large Prompt set. Cron does not have
this problem — it gets the Cron Trigger's full fifteen minutes with no client
attached — so the cheapest fix for a lost ChatGPT day is usually to let the
next morning's sweep run.

Without `--resume` a re-run collects the date afresh, which is what you want when
the existing Runs are suspect rather than merely missing.

Provider latency is worse during US business hours: overnight-US sweeps run
well inside the call timeout while midday re-runs of the same Prompts can time
out over half the time. Re-run off-peak where the choice exists.

## Local development

```sh
cp .dev.vars.example .dev.vars   # then fill in the keys
npm run db:migrate:local
npm run dev
```

Then `curl -X POST -H 'Origin: http://localhost:4321' http://localhost:4321/api/sync-config`
to load the config into the local database.

## Changing what is tracked

Prompts, Topics, Brands and the Domain Type seed map are versioned config files
in `config/`. Edit them, commit, and deploy — the sync upserts the changes and
deactivates anything removed. Deactivation never deletes Runs, so history stays
queryable.
