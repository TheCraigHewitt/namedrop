# Contributing to NameDrop

Thanks for your interest. NameDrop is a small, focused tool with some sharp
operational constraints, so please read this before opening a PR.

## Before you start

- **Read [CONTEXT.md](CONTEXT.md).** The domain vocabulary there — Brand,
  Prompt, Topic, Surface, Run, Response, Mention, Position, Visibility, Source,
  Domain, Domain Type, Fanout — is used precisely in code, schema, UI and
  discussion. Use those terms in issues and PRs too.
- **Changing how ChatGPT is called, or anything cost-related?** Read
  [docs/costs.md](docs/costs.md) first. The collection settings are the result
  of measurement, not preference, and several obvious ideas (Batch API,
  `effort: minimal`, moving the schedule) are already ruled out.
- **Fixing a timeout, 500, missing data, or auth failure?** Read
  [docs/known-issues.md](docs/known-issues.md) first. Most of these have
  happened before and looked like something else the first time.

For anything larger than a small fix, open an issue first so we can agree on
the approach before you invest time in it.

## Development setup

Prerequisites: Node 20+.

```sh
npm install
cp .dev.vars.example .dev.vars   # provider API keys, never committed
npm run db:migrate:local
npm run dev
```

You do not need real provider keys to run the test suite — tests use recorded
fixtures at the HTTP boundary.

## Tests

```sh
npm test            # builds, then runs the suite
npm run typecheck
```

Both must pass; CI runs them on every PR.

- Tests drive the real Worker through its real entry points (the request
  handler and the cron handler) against a real local D1. Only the HTTP
  boundary to the AI providers is faked. **Don't mock internals.**
- **Seed past 100 rows** when testing anything that pages or batches. D1
  rejects queries with more than 100 bound parameters, and bugs in that class
  have shipped precisely because tests seeded a handful of rows where
  production has hundreds.

## Hard rules

These encode incidents that cost real money or real data:

- **D1 rejects queries with more than 100 bound parameters.** Any
  `IN (?, ?, …)` built from an array is suspect — chunk it.
- **A failed Run must never replace a successful one.** A successful Run
  replacing a failed one is fine (that's what makes `--resume` work).
- **Never swallow an error.** No bare `.catch(() => {})` — silent failure has
  hidden a completely broken feature for days before.
- **Size a batch to the limit that actually applies** — D1's 100-parameter
  limit and an LLM call's timeout are different constraints.

## Style

- Comments explain **why**, not what — especially non-obvious constants, which
  usually encode a limit discovered the hard way.
- Match the existing code style; keep changes small and focused.

## Submitting

1. Fork, branch from `main`.
2. Make your change with tests.
3. Ensure `npm test` and `npm run typecheck` pass.
4. Open a PR describing what changed and why. Link the issue if there is one.
