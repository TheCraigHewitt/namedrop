# NameDrop

Does ChatGPT name-drop you? NameDrop is a self-hosted tracker for how often
your brand — and your competitors — appear in AI assistant answers to the
questions your customers ask. A single Cloudflare Worker collects answers daily
from ChatGPT, Perplexity and Gemini, detects Brand mentions, and serves a
dashboard plus CSV exports. An alternative to hosted AEO trackers like Peec.ai,
at a fraction of the price.

Domain vocabulary is defined in [CONTEXT.md](CONTEXT.md) — Brand, Prompt, Topic,
Surface, Run, Response, Mention, Position, Visibility, Share of Voice, Source,
Domain, Domain Type, Fanout. Those terms are used in the code, schema and UI.

> **ChatGPT collection requires a paid [cloro.dev](https://cloro.dev) plan
> (Lite or above).** The ChatGPT Surface is a real chatgpt.com session driven
> through cloro's API — that is what makes the numbers match what real users
> see. The free tier runs a single concurrent job, which puts a daily sweep
> past the Cloudflare Cron Trigger's 15-minute cap; collection needs the Lite
> plan's concurrency. Note the supply risk: cloro scrapes chatgpt.com, which
> sits in ToS-gray territory. If it dies, an OpenAI API fallback path lives in
> `src/lib/surfaces/chatgpt.ts` — swapping the adapter back is a small, tested
> change, at the cost of measuring the API instead of the product.

## Shape

One Cloudflare Worker does everything:

- `fetch` — the Astro dashboard and the CSV export endpoints.
- `scheduled` — the daily collection sweep. One sweep is every active Prompt
  against **one** Surface, on its own schedule (07:00, 07:20 and 07:40 UTC),
  because a Cron Trigger is killed at 15 minutes of wall clock and all three
  Surfaces in one firing does not fit.

Storage is D1. Auth is Cloudflare Access in front of the Worker; there is no
auth code in the app.

The dashboard has five views: Overview (Visibility trends and the Brand
leaderboard), Prompts (per-Prompt metrics for content targeting), Runs (browse
what the assistants actually said), Sources (Domain leaderboard and Domain Type
mix), and Health (per-Surface collection coverage). `/export/*.csv` serves
Peec-shaped exports for downstream content tooling — see
[docs/exports.md](docs/exports.md).

## Quickstart

Prerequisites: a Cloudflare account, Node 20+, and API keys for Perplexity,
OpenAI (Domain classifier + calibration), Gemini, and cloro.dev (paid plan —
see above).

1. **Configure what you track.** `config/` ships as a worked example in the
   podcast-hosting niche — `brands.json` (mark exactly one Brand `isSelf`;
   the example uses Castos as "you" against real competitors), `prompts.json`,
   `topics.json`, and `domain-types.json` (a tiny seed map; unseeded Domains
   are auto-classified by LLM at first sight). Replace with your own market.

2. **Create the D1 database** and paste the returned `database_id` into
   `wrangler.jsonc` (replacing `PLACEHOLDER_SET_BY_WRANGLER_D1_CREATE`):

   ```sh
   npx wrangler d1 create namedrop
   ```

3. **Apply migrations**: `npm run db:migrate:remote`

4. **Set the four provider secrets**:

   ```sh
   npx wrangler secret put PERPLEXITY_API_KEY
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put CLORO_API_KEY
   ```

5. **Deploy**: `npm run deploy`

6. **Put Cloudflare Access in front of the Worker.** This is not optional —
   there is no auth code in the app; an unprotected hostname serves your whole
   dashboard and database to the internet. See
   [docs/deploy.md](docs/deploy.md) for the exact policies, including the
   service-token setup for scripted access to the exports.

Collection then runs daily on the cron schedule. The Health page shows
per-Surface coverage; [docs/deploy.md](docs/deploy.md) covers verifying the
first sweep and re-running a lost date.

## Running it

- [docs/deploy.md](docs/deploy.md) — one-time setup, Access, re-running a date.
- [docs/costs.md](docs/costs.md) — where the money goes and why the collection
  settings are what they are. ChatGPT is effectively the whole bill; Gemini and
  Perplexity are a rounding error. Read this before changing anything about
  how ChatGPT is called — several obvious cost ideas are measured dead ends.
- [docs/known-issues.md](docs/known-issues.md) — failure modes the original
  deployment actually hit, and the open ones. Read this before debugging
  anything that looks like a timeout, a 500, or missing data.
- [docs/exports.md](docs/exports.md) — the CSV exports.

## What is tracked

`config/` holds the versioned config: `topics.json`, `prompts.json`,
`brands.json` (with alias lists), and `domain-types.json` (the Domain Type seed
map). Editing tracking is a git commit — `POST /api/sync-config` reconciles the
files into D1, upserting changes and deactivating anything removed. Nothing is
ever deleted, so history stays queryable.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars   # provider API keys, never committed
npm run db:migrate:local
npm run dev
```

## Tests

```sh
npm test        # builds, then runs the suite
npm run typecheck
```

Tests run the real Worker in workerd against a real local D1 via Cloudflare's
Vitest workers pool, driving it through its two real entry points — the request
handler and the cron handler. The only thing faked is the HTTP boundary to the
AI providers, using recorded fixtures. Parsing, D1 writes, metric SQL, page
rendering and CSV output are all exercised for real.

`npm test` builds first because the pool loads the built Worker from
`dist/server`. `worker-configuration.d.ts` is generated by `wrangler types` (run
automatically before `npm run typecheck`) and is not committed.

## License

[MIT](LICENSE)
