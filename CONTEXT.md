# NameDrop

Self-hosted tool that tracks how often your brand and its competitors appear in
AI assistant answers to the questions your customers ask, over time. An
alternative to hosted AEO trackers like Peec.ai. Serves two consumers: a web
dashboard for the team, and structured data exports for downstream content
tooling.

The shipped `config/` is a worked example in the podcast-hosting niche; replace
it with your own market.

## Language

**Brand**:
A company we track mentions of — your own (marked `isSelf` in config) or a
competitor. Each Brand has an alias list used for detection.
_Avoid_: company, competitor (a competitor is just a Brand that isn't yours)

**Prompt**:
A tracked question we send to AI models on a schedule (e.g. "Best places to
host a new podcast?"). Belongs to one Topic.
_Avoid_: query (reserved for Fanout searches), keyword

**Topic**:
A named grouping of Prompts (e.g. "Private podcast hosting services"). Used for
filtering and aggregation.
_Avoid_: tag, category, cluster

**Surface**:
An AI system we query — ChatGPT (a real chatgpt.com session via cloro.dev),
Perplexity (Sonar API), Gemini (with Google Search grounding).
_Avoid_: model, engine (a Surface may change underlying model versions over time)

**Run**:
One execution of one Prompt against one Surface on one day, producing a stored
Response. Cadence: 1 run per Prompt per Surface per day.
_Avoid_: chat, execution, sample

**Response**:
The full answer text a Surface returned for a Run, stored verbatim along with
its citations and Fanout queries.
_Avoid_: answer, completion

**Mention**:
A Brand appearing in a Response, detected by deterministic alias matching.
Carries a rank: the order of first appearance among all mentioned Brands.
_Avoid_: hit, appearance

**Position**:
A Brand's rank within a single Response (1 = first Brand mentioned). Aggregated
as the average over Runs where the Brand was mentioned.

**Visibility**:
The fraction of Runs (in a window, typically 7-day rolling) whose Response
mentions a given Brand. Ranges 0–1.
_Avoid_: presence, coverage

**Share of Voice (SoV)**:
A Brand's Mentions divided by total Mentions of all tracked Brands in the same
window.

**Source**:
A URL cited in a Response. Rolls up to a Domain.
_Avoid_: link, reference

**Domain**:
The registrable domain of a Source (e.g. reddit.com). Retrieval counts and
leaderboards aggregate at this level.

**Domain Type**:
A Domain's classification for source analysis: Corporate, UGC, Editorial,
Reference, Institutional, Competitor, You (the self Brand's own domain), or
Other. Assigned once (from the seed map in config, or auto-classified at first
sight) and then fixed.

**Fanout**:
A web search query a Surface performed while answering a Prompt (e.g. ChatGPT
searching "private podcast hosting services official"). Reveals what the model
actually looked up.
