# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub's private vulnerability reporting](https://github.com/TheCraigHewitt/namedrop/security/advisories/new)
rather than opening a public issue.

You should get a response within a few days. Please include enough detail to
reproduce the issue.

## Scope notes for self-hosters

- **The app contains no auth code by design.** The entire security boundary is
  Cloudflare Access in front of the Worker. An unprotected hostname serves your
  whole dashboard and database to the internet — see
  [docs/deploy.md](docs/deploy.md) for the required Access setup. A
  misconfigured Access policy on your own deployment is not a vulnerability in
  NameDrop.
- Provider API keys are Worker secrets (`wrangler secret put`), never committed.
  Local keys live in `.dev.vars`, which is gitignored.
