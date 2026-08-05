# Running costs

The settings in this project are the result of measurement on a real
deployment, not preference. The specific dollar amounts from that deployment
are not reproduced here — search volume, Prompt count and model routing all
move them — but the constraints and the method are portable. Measure your own
deployment before changing anything below; several obvious ideas are already
ruled out.

## Pick a benchmark

Decide what number the running cost has to stay under to justify the tool
existing. This project replaced Peec.ai at $99/month, so that was the ceiling
every decision was measured against. Without a benchmark, "cheaper" has no
meaning.

## Where the money goes

**ChatGPT is effectively the entire bill.** Gemini and Perplexity together cost
a rounding error: Google's Search grounding free tier covers a day's Prompts,
and Perplexity's Sonar bills per request at a trivial rate.

Do not optimise Gemini or Perplexity. There is nothing there to save.

ChatGPT collection runs through [cloro.dev](https://cloro.dev) — browser
automation over the real chatgpt.com — at a flat subscription price (the
$30/month Lite plan covers daily collection of ~50 Prompts with credits to
spare). Flat pricing means no token-volume exposure at all. The constraints
that matter:

- **Never point collection at a free-tier cloro key.** The free tier runs 1
  concurrent job, and a sequential sweep of a full Prompt set runs well past
  the Cron Trigger's 15-minute cap. The sweep's concurrency needs the Lite
  plan's 10 concurrent jobs.
- **Supply risk.** cloro sits on ToS-gray scraping. The OpenAI API path stays
  in `src/lib/surfaces/chatgpt.ts` as the fallback (and for `/api/calibrate`);
  swapping the adapter's `run()` back is a small, tested change.
- **Token usage columns are null for cloro Runs.** Flat per-request billing;
  the columns keep their meaning for any API-era history.

What cloro buys besides price: it *is* the product. Whatever model OpenAI
routes a real chatgpt.com session to is the answer real users get, web search
is always on as in the product, and geography is an explicit parameter. On the
reference deployment it also returned about three times as many cited Sources
per Response as the API's annotations, with better run-to-run stability.

## The API cost anatomy, if you use the fallback

Verified against OpenAI's published pricing: `web_search` on reasoning models
carries a flat fee per 1,000 calls, and the pages a search pulls in are billed
as ordinary input tokens at the model's rate. Reasoning tokens bill as output.

Measured on the reference deployment, no single component dominated: search
fees, input tokens and output tokens each carried a comparable share of the
bill. **There is no single knob.** And how much the model chooses to search
varies by Prompt more than any setting controls, so per-Run costs spread
widely around their average.

One inference error worth not re-deriving: a day whose timed-out calls are
billed in full but store no usage will misattribute the discarded calls'
tokens to whatever component you can still see. Compute cost splits only from
Runs with recorded usage.

### Hard constraints

- **`effort: minimal` and `none` cannot be used with web search.** OpenAI
  rejects the request: `The following tools cannot be used with
  reasoning.effort 'minimal': web_search`. `low` is the floor.
- **The Batch API cannot be used**, despite its 50% discount and the fact that
  nothing here is time-sensitive. `web_search` is unsupported in batch and
  fails with `web_search_unsupported`.
- **There is no off-peak pricing.** Moving the schedule cannot reduce unit
  cost. It only affects latency — which matters, because a timed-out call is
  billed in full and stored as nothing. Latency is a cost problem, not just a
  reliability one. Provider latency is markedly worse during US business
  hours; an overnight-US cron is the cheap slot.

### Reasoning effort couples cost to grounding

Reasoning effort drives how many times the model searches, so cost and
grounding depth cannot be tuned independently. On the reference deployment,
dropping from default effort to `effort: low` roughly halved input tokens,
output tokens, searches and latency at once.

The latency point generalises: when a timeout is cutting through the middle of
the latency distribution rather than trimming its tail, raising the timeout
changes nothing. Lowering effort (or changing model) moves the whole
distribution instead.

## Cheaper models change the answer — measure before switching

The tempting cost levers — a cheaper model, `search_context_size: low` — were
measured and rejected, because they change *what is measured*, not just what
it costs. The method, which is worth re-running for any config change:

1. Sample one Prompt per Topic (`POST /api/calibrate?config=N&prompts=6`).
2. Run every candidate config at least twice.
3. Score each config by the mean Jaccard overlap of its detected Brand sets
   against the baseline config's runs.
4. Establish the noise floor first: the baseline's agreement with itself.
   Single samples cannot separate a config effect from ordinary run-to-run
   LLM variance.

On the reference deployment, every cheap config fell well below the noise
floor and named fewer Brands per Response. The savings are not savings: they
change which Brands get counted, which is the product.

`/api/calibrate` **writes nothing** — it runs the same Prompts repeatedly, and
storing that would put non-comparable Runs into the trend data. One config per
request: Cloudflare cuts a request off at about six minutes. Check the
`config` label in each response before trusting a batch — a stale deployment
serving an old config list looks exactly like a real measurement.

## Discontinuities

Every change to settings, model or collection mechanism creates a
discontinuity: Runs across that line are not comparable, and any rolling
window straddling it blends non-comparable data. Record the date of every such
change; the `model` column on each Run marks which era it belongs to
(`chatgpt-web` marks cloro-collected Runs). Expect level shifts in the
affected Surface's series and read trends within eras, not across them.

This also cuts the other way: when the underlying product moves (chatgpt.com
reroutes to a new default model), *not* following it means measuring a model
real users no longer talk to. A dashboard built on a retired model is bad
data, not cheap data. Accuracy beats continuity — and on the reference
deployment, following the product visibly stepped the self Brand's trend line.
That step is the corrected picture, not a regression.

## If costs need to fall further

The remaining levers change how *often* the same thing is measured, not *what*
is measured:

1. **Reduce ChatGPT cadence.** Every other day roughly halves the ChatGPT
   bill, but also halves per-Prompt-per-Surface samples per rolling window —
   which is where the per-Prompt view stops being readable. The aggregate
   survives; the detail does not.
2. **Cut Prompts.** Linear. But a Prompt where your Brand is never mentioned
   is not dead weight — it is a competitive gap, arguably the most actionable
   row in the tool.

Reducing cadence does **not** reduce noise, despite the intuition. Visibility
is a fraction over a rolling window, and that window suppresses LLM sampling
variance by averaging many samples: halving collection makes each point about
1.4× noisier. If the dashboard merely looks noisy, widen the display window
rather than collecting less.
