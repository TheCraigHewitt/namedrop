# CSV exports

Five endpoints for downstream content tooling — anything that wants the
dashboard's numbers as structured data. Their column shapes mirror Peec.ai's
exports, so research scripts written against those files port with minimal
change.

| Endpoint | Mirrors |
| --- | --- |
| `/export/prompts.csv` | Peec prompts export |
| `/export/domains.csv` | Peec gap-domains export |
| `/export/top-rankings.csv` | Peec top-rankings export |
| `/export/performance-matrix.csv` | Peec performance-matrix export |
| `/export/fanouts.csv` | Peec query-fanouts export |

## Filters

Every endpoint accepts the same parameters as the dashboard, and exported
numbers match what the dashboard shows for the same filters:

| Parameter | Meaning | Default |
| --- | --- | --- |
| `from`, `to` | Inclusive date range, `YYYY-MM-DD` | last 30 days |
| `surface` | `chatgpt`, `perplexity` or `gemini` | all Surfaces |
| `topic` | A Topic id, e.g. `podcast-hosting-platforms` | all Topics |

## Authentication

The Worker sits behind Cloudflare Access, so scripts authenticate with a service
token rather than a login. Set the token in the consuming tool's environment and
send it as two headers:

```sh
curl -sS \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  "https://namedrop.your-team.workers.dev/export/prompts.csv?from=2026-07-01&to=2026-07-31" \
  -o prompts.csv
```

Creating the token and the Service Auth policy is step 6 of
[docs/deploy.md](deploy.md).

Give each consumer its own service token, so rotating one leaves the others
alone.

### When a token gets a 302 instead of a 200

Access says why in the redirect it sends back. Decode it — no secrets are
printed, and the credentials go in as headers rather than on the command line:

```sh
set -a; source .env; set +a
curl -s -o /dev/null -D - \
  -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
  -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
  https://namedrop.your-team.workers.dev/export/prompts.csv \
| grep -i '^location:' \
| python3 -c "
import sys,urllib.parse,base64,json
q=urllib.parse.parse_qs(urllib.parse.urlparse(sys.stdin.read().strip().split(' ',1)[1]).query)
p=q.get('meta',[''])[0].split('.')[1]; p+='='*(-len(p)%4)
print(json.loads(base64.urlsafe_b64decode(p)).get('service_token_status'))
"
```

- **`False`** — Access never validated the token. Almost always the policy's
  action is `Allow` with the token in its Include, which looks right in the UI
  and can never work, because `Allow` requires an interactive login. The action
  must be `Service Auth`. Failing that, the Client ID and Secret are halves of
  two different tokens; both look well-formed, so only the dashboard can tell.
- **`True`, still redirecting** — the token is valid but unauthorized: move the
  Service Auth policy above the Allow policy.
- **no output** — the request was allowed through. It works.

A well-formed Client ID is 32 hex characters plus `.access`; a Client Secret is
64 hex characters. Checking the lengths rules out a truncated paste before you
go looking at policies.

> The Access application must cover every route the Worker answers on, including
> any `*.workers.dev` hostname. Access is the only thing protecting these
> endpoints — there is no auth check in the app itself.

## Differences from the Peec exports

The column shapes match; some values cannot. Columns Peec filled with metrics
that are out of scope here are kept and left **empty** rather than dropped, so
parsing by header position still works.

- **`sentiment`, `sentiment_delta`** (prompts) — empty. Sentiment scoring is out
  of scope.
- **`gap_score`, `citation_rate`, `citation_rate_delta`** (domains) — empty.
  Gap analysis scoring is out of scope.
- **`volume`, `tags`, `location`, `web_search`, `web_search_delta`, `added_at`**
  (prompts) — empty. Not tracked.
- **`retrieved`** (domains) — a **citation count** here. Peec reported a rate in
  this column. `retrieval_rate` is the comparable 0–1 figure: the share of Runs
  citing the Domain at least once.
- **`visibility`, `share_of_voice`** (prompts) — 0–1 rates, not percentages, to
  four decimal places.
- **`mentions`** (prompts) — the Brands mentioned, comma-separated, as in Peec.
