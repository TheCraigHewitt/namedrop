# Provider fixtures

The only thing faked in this test suite is the HTTP boundary to the AI
providers. These files are the response bodies those APIs return, shaped to each
provider's documented response schema, and are replayed by
`test/fake-providers.ts` in place of a real network call. Everything downstream —
parsing, Mention detection, D1 writes, metric SQL, page rendering, CSV output —
runs for real.

Each fixture is named for the edge case it covers, and the sweep tests assert on
the D1 rows a sweep over them produces.

> Re-record against the live APIs when provider response shapes change: run a
> single Prompt with a real key and save the raw response body here unmodified.
