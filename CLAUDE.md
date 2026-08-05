# Working on this project

Read [CONTEXT.md](CONTEXT.md) for the domain vocabulary. The terms there — Brand,
Prompt, Topic, Surface, Run, Response, Mention, Position, Visibility, Source,
Domain, Domain Type, Fanout — are used precisely, in code, schema, UI and
conversation. Use them.

## Read these before acting

- **Changing how ChatGPT is called, or anything about cost** →
  [docs/costs.md](docs/costs.md) first. The settings are the result of
  measurement, not preference, and several obvious ideas are already ruled out
  (Batch API, `effort: minimal`, moving the schedule to save money).
- **Debugging a timeout, a 500, missing data, or an auth failure** →
  [docs/known-issues.md](docs/known-issues.md) first. Most of these have happened
  before and looked like something else the first time.
- **Deploying, or setting up access** → [docs/deploy.md](docs/deploy.md).

## Things that have cost real money or real data

- **D1 rejects queries with more than 100 bound parameters.** This has broken
  three separate features. Any `IN (?, ?, …)` built from an array is suspect: a
  day of collection at 48 Prompts is ~144 Runs and cites 300+ Domains.
- **Tests must seed past 100 rows** to exercise anything that pages or batches.
  Two of those three bugs shipped because tests seeded a handful of Runs where
  production has hundreds.
- **A failed Run must never replace a successful one.** Violating this destroyed
  a morning's data once. A successful Run replacing a failed one is fine, and is
  what makes `--resume` work.
- **Never swallow an error.** Domain classification had a bare `.catch(() => {})`
  and had never worked in production; nothing said so for days.
- **Size a batch to the limit that actually applies.** Classification chunked at
  D1's 100 because that constant was in scope, and no LLM call that size ever
  finished inside its timeout.
- **Verify against production before reporting a fix.** Deploys take a moment to
  propagate; a check run too early reports a working fix as broken.

## Provider spend

The ChatGPT Surface is a **real chatgpt.com session via cloro.dev** — whatever
model OpenAI routes, web search always on, US geography — at a flat price
(cloro's Lite plan). Gemini and Perplexity cost next to nothing — there is
nothing to optimise there. Cheaper API models and smaller search context were
measured to change which Brands get named — the real-session path is both the
accuracy choice and the cheap one. [docs/costs.md](docs/costs.md) before
touching any collection setting.

**Never point collection at a free-tier cloro key** — 1 concurrent job blows
the 15-minute cron cap. The OpenAI API path stays in `chatgpt.ts` for
`/api/calibrate` and as the fallback if cloro dies.

A call that times out is billed in full and stored as nothing. Latency is a cost
problem, not just a reliability one.

Know your benchmark: the number the running cost has to stay under to justify
the tool existing (for the original deployment, the $99/month tracker it
replaced).

## Conventions

- Comments explain **why**, not what — especially the non-obvious constants,
  which usually encode a limit discovered the hard way.
- Tests drive the real Worker through its real entry points; only the HTTP
  boundary to providers is faked. Don't mock internals.
- `npm test` builds first, because the test pool loads the built Worker.
