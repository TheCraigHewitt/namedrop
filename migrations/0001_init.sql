-- Core schema. Terms follow CONTEXT.md: Brand, Prompt, Topic, Surface, Run,
-- Response, Mention, Position, Source, Domain, Domain Type, Fanout.
--
-- Config-derived tables (topics, prompts, brands, brand_aliases, brand_domains)
-- are upserted from config/*.json on every sync; rows dropped from config are
-- deactivated, never deleted, so historical Runs stay queryable.

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  text TEXT NOT NULL,
  intent TEXT,
  branding TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_prompts_topic ON prompts(topic_id);

CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Aliases are stored lowercased; matching is case-insensitive and word-bounded.
-- not_followed_by holds a JSON array of words that veto a match, which is how
-- ambiguous aliases like "Anchor" avoid firing on "anchor text".
CREATE TABLE brand_aliases (
  brand_id TEXT NOT NULL REFERENCES brands(id),
  alias TEXT NOT NULL,
  not_followed_by TEXT,
  PRIMARY KEY (brand_id, alias)
);

CREATE TABLE brand_domains (
  brand_id TEXT NOT NULL REFERENCES brands(id),
  domain TEXT NOT NULL,
  PRIMARY KEY (brand_id, domain)
);

-- A Domain's Type is assigned once at first sight and then fixed.
CREATE TABLE domains (
  domain TEXT PRIMARY KEY,
  domain_type TEXT NOT NULL,
  classified_by TEXT NOT NULL, -- 'seed' | 'brand' | 'llm' | 'fallback'
  classified_at TEXT NOT NULL
);

-- One sweep = one cron firing across all active Prompts and Surfaces.
CREATE TABLE sweeps (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL, -- 'running' | 'ok' | 'partial' | 'failed'
  ok_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0
);

-- One Run = one Prompt against one Surface on one day.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  sweep_id TEXT REFERENCES sweeps(id),
  prompt_id TEXT NOT NULL REFERENCES prompts(id),
  surface TEXT NOT NULL,
  run_date TEXT NOT NULL, -- YYYY-MM-DD (UTC)
  created_at TEXT NOT NULL,
  status TEXT NOT NULL, -- 'ok' | 'failed'
  error TEXT,
  model TEXT,
  response_text TEXT,
  UNIQUE (prompt_id, surface, run_date)
);
CREATE INDEX idx_runs_date ON runs(run_date);
CREATE INDEX idx_runs_surface_date ON runs(surface, run_date);
CREATE INDEX idx_runs_status ON runs(status, run_date);

-- Position = order of first appearance among the Brands mentioned in a Response.
-- sentiment is reserved: scoring is out of scope, but the column keeps it unblocked.
CREATE TABLE mentions (
  run_id TEXT NOT NULL REFERENCES runs(id),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  position INTEGER NOT NULL,
  first_index INTEGER NOT NULL,
  mention_count INTEGER NOT NULL,
  sentiment REAL,
  PRIMARY KEY (run_id, brand_id)
);
CREATE INDEX idx_mentions_brand ON mentions(brand_id);

CREATE TABLE sources (
  run_id TEXT NOT NULL REFERENCES runs(id),
  ordinal INTEGER NOT NULL, -- citation order within the Response
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT,
  PRIMARY KEY (run_id, ordinal)
);
CREATE INDEX idx_sources_domain ON sources(domain);

CREATE TABLE fanouts (
  run_id TEXT NOT NULL REFERENCES runs(id),
  ordinal INTEGER NOT NULL,
  query TEXT NOT NULL,
  PRIMARY KEY (run_id, ordinal)
);
