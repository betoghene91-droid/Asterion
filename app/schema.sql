-- Asterion V1 schema (Cloudflare D1 / SQLite)
-- The schema is the contract: Worker, Actions runners and dashboard all read it.

PRAGMA foreign_keys = ON;

-- ─────────────────────────────── discovery ───────────────────────────────
CREATE TABLE IF NOT EXISTS programs (
  id            TEXT PRIMARY KEY,            -- slug: host or platform:id
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL DEFAULT 'self', -- self|hackerone|bugcrowd|immunefi|cantina|c4|sherlock|codehawks|hackenproof|intigriti|yeswehack
  homepage      TEXT,
  policy_url    TEXT,
  policy_sha    TEXT,                         -- hash of policy text at last fetch
  policy_text   TEXT,
  -- gating field. every dispatch reads this. never inferred from prose elsewhere.
  automation    TEXT NOT NULL DEFAULT 'unknown'
                CHECK (automation IN ('allowed','not_mentioned','prohibited','unknown')),
  reward        TEXT NOT NULL DEFAULT 'unknown'
                CHECK (reward IN ('monetary','swag','recognition','none','unknown')),
  safe_harbour  INTEGER NOT NULL DEFAULT 0,
  responsiveness REAL,                        -- 0..1, updated from outcomes
  priority      REAL NOT NULL DEFAULT 0.5,
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','crawled','parsed','active','paused','dead')),
  discovered_at INTEGER NOT NULL,
  last_checked  INTEGER,
  next_check    INTEGER,
  meta          TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_programs_next   ON programs(status, next_check);
CREATE INDEX IF NOT EXISTS idx_programs_auto   ON programs(automation, status);

CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  program_id  TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                  -- domain|host|url|api|cidr|chain_address|repo|apk|ipa
  value       TEXT NOT NULL,
  in_scope    INTEGER NOT NULL DEFAULT 1,
  chain_id    INTEGER,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}',
  UNIQUE(program_id, kind, value)
);
CREATE INDEX IF NOT EXISTS idx_assets_prog ON assets(program_id, in_scope);

-- ─────────────────────────────── engagement ───────────────────────────────
-- One engagement = one time-boxed, authorized hunt. Every probe points here.
CREATE TABLE IF NOT EXISTS engagements (
  id               TEXT PRIMARY KEY,
  program_id       TEXT NOT NULL REFERENCES programs(id),
  title            TEXT NOT NULL,
  brief            TEXT NOT NULL,             -- JSON, produced by the intake wizard
  authorization_ref TEXT NOT NULL,            -- exact policy sentence relied on
  window_start     INTEGER NOT NULL,
  window_end       INTEGER NOT NULL,
  time_box_minutes INTEGER NOT NULL DEFAULT 240,
  max_mutability   TEXT NOT NULL DEFAULT 'read'
                   CHECK (max_mutability IN ('read','simulate','mutate','destructive')),
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('draft','open','paused','closed','abandoned')),
  created_at       INTEGER NOT NULL,
  closed_at        INTEGER,
  spend_cents      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_eng_status ON engagements(status, window_end);

-- ─────────────────────────────── probing ───────────────────────────────
CREATE TABLE IF NOT EXISTS probes (
  id            TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  playbook_id   TEXT NOT NULL,
  probe_id      TEXT NOT NULL,
  target        TEXT NOT NULL,
  mutability    TEXT NOT NULL,
  verdict       TEXT NOT NULL DEFAULT 'pending'
                CHECK (verdict IN ('pending','allow','deny','needs_approval')),
  state         TEXT NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','running','done','skipped','error')),
  started_at    INTEGER, finished_at INTEGER,
  output_digest TEXT,
  error         TEXT,
  UNIQUE(engagement_id, playbook_id, probe_id, target)
);
CREATE INDEX IF NOT EXISTS idx_probes_state ON probes(state, engagement_id);

-- ─────────────────────────────── findings ───────────────────────────────
-- proof_state is the load-bearing field. only 'proven' may be reported.
CREATE TABLE IF NOT EXISTS findings (
  id           TEXT PRIMARY KEY,
  engagement_id TEXT REFERENCES engagements(id) ON DELETE SET NULL,
  program_id   TEXT REFERENCES programs(id),
  asset_id     TEXT REFERENCES assets(id),
  title        TEXT NOT NULL,
  cls          TEXT NOT NULL,                 -- playbook/class id
  severity     TEXT NOT NULL DEFAULT 'info'
               CHECK (severity IN ('critical','high','medium','low','info')),
  confidence   TEXT NOT NULL DEFAULT 'tentative'
               CHECK (confidence IN ('tentative','firm','confirmed')),
  proof_state  TEXT NOT NULL DEFAULT 'hypothesis'
               CHECK (proof_state IN ('hypothesis','partial','proven','disproved')),
  status       TEXT NOT NULL DEFAULT 'candidate'
               CHECK (status IN ('candidate','triaged','reported','accepted','rejected','duplicate','fixed')),
  dedupe_key   TEXT NOT NULL,
  summary      TEXT,
  impact       TEXT,
  remediation  TEXT,
  repro        TEXT,                           -- JSON array of steps actually executed
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_dedupe ON findings(program_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_findings_queue ON findings(status, severity);

CREATE TABLE IF NOT EXISTS evidence (
  id         TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                   -- http_exchange|command_output|code_reference|screenshot|tx_trace|other
  payload    TEXT NOT NULL,                   -- JSON
  digest     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_finding ON evidence(finding_id);

-- ─────────────────────────────── safety ───────────────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  action      TEXT NOT NULL,                  -- JSON
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','denied','expired')),
  requested_at INTEGER NOT NULL,
  decided_at   INTEGER,
  operator     TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(status, requested_at);

-- hash-chained, append-only. mirrors asterion/ledger.py
CREATE TABLE IF NOT EXISTS ledger (
  seq       INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL UNIQUE
);

-- ─────────────────────────────── operations ───────────────────────────────
CREATE TABLE IF NOT EXISTS quota (
  day     TEXT NOT NULL,                      -- YYYY-MM-DD (UTC)
  bucket  TEXT NOT NULL,                      -- subrequests|llm_tokens|r2_ops|d1_rows|neurons
  used    INTEGER NOT NULL DEFAULT 0,
  cap     INTEGER NOT NULL,
  PRIMARY KEY(day, bucket)
);

CREATE TABLE IF NOT EXISTS heartbeats (
  source TEXT PRIMARY KEY,                    -- worker|cron|crawler|sentinel|actions
  ts     INTEGER NOT NULL,
  note   TEXT
);

CREATE TABLE IF NOT EXISTS llm_log (
  id        TEXT PRIMARY KEY,
  ts        INTEGER NOT NULL,
  provider  TEXT NOT NULL,
  model     TEXT NOT NULL,
  prompt_sha TEXT NOT NULL,
  tokens_in INTEGER, tokens_out INTEGER,
  latency_ms INTEGER,
  ok        INTEGER NOT NULL,
  error     TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_ts ON llm_log(ts);

-- ─────────────────────────────── learning ───────────────────────────────
CREATE TABLE IF NOT EXISTS corpus (
  id        TEXT PRIMARY KEY,
  firm      TEXT, project TEXT, year INTEGER,
  severity  TEXT, cls TEXT, fix_status TEXT, review_type TEXT,
  title     TEXT, body TEXT, url TEXT,
  signals   TEXT,                             -- YOUR enrichment: detection signals
  added_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corpus_cls ON corpus(cls, severity);

CREATE TABLE IF NOT EXISTS evals (
  id         TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,
  playbook_id TEXT NOT NULL,
  corpus_n   INTEGER NOT NULL,
  tp INTEGER NOT NULL, fp INTEGER NOT NULL, fn INTEGER NOT NULL,
  precision  REAL, recall REAL,
  notes      TEXT
);

-- ─────────────────────────── sentinel / watchlist ───────────────────────────
CREATE TABLE IF NOT EXISTS watchlist (
  id         TEXT PRIMARY KEY,
  chain_id   INTEGER NOT NULL,
  address    TEXT NOT NULL,
  label      TEXT NOT NULL,
  rules      TEXT NOT NULL DEFAULT '[]',      -- JSON array of rule ids
  last_block INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  UNIQUE(chain_id, address)
);

CREATE TABLE IF NOT EXISTS alerts (
  id         TEXT PRIMARY KEY,
  watch_id   TEXT REFERENCES watchlist(id) ON DELETE CASCADE,
  rule       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  acked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_unsent ON alerts(sent_at, created_at);

-- ─────────────────────────── conversation state ───────────────────────────
-- The intake wizard's memory. This is what makes bad prompts survivable.
CREATE TABLE IF NOT EXISTS intake_sessions (
  chat_id    INTEGER PRIMARY KEY,
  state      TEXT NOT NULL DEFAULT 'idle',
  draft      TEXT NOT NULL DEFAULT '{}',
  step       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- ───────────────────────────── misc state ─────────────────────────────
-- Small, hot key/value: operator chat id, last-seen cursors, feature flags.
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ─────────────────────────────── V2: hunts ───────────────────────────────
-- A hunt is a row, not a process. That is what makes it resumable and what
-- lets the Worker, Actions, and Telegram all reason about the same state.
CREATE TABLE IF NOT EXISTS hunts (
  id            TEXT PRIMARY KEY,
  program_id    TEXT REFERENCES programs(id),
  engagement_id TEXT REFERENCES engagements(id),
  repo          TEXT,
  commit_sha    TEXT,
  contract      TEXT,
  fork_block    INTEGER,
  stage         TEXT NOT NULL DEFAULT 'rank'
                CHECK (stage IN ('rank','lead','prime','attempt','judge','done','failed')),
  leads_n       INTEGER NOT NULL DEFAULT 0,
  attempts_n    INTEGER NOT NULL DEFAULT 0,
  proven_n      INTEGER NOT NULL DEFAULT 0,
  stopped_because TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hunts_stage ON hunts(stage, updated_at);

-- One row per PoC attempt. The verdict here is what the queue reads.
CREATE TABLE IF NOT EXISTS proofs (
  id          TEXT PRIMARY KEY,
  hunt_id     TEXT NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  playbook    TEXT NOT NULL,
  test_name   TEXT NOT NULL,
  file        TEXT,
  line        INTEGER,
  verdict     TEXT NOT NULL DEFAULT 'inconclusive'
              CHECK (verdict IN ('proven','partial','disproved','inconclusive')),
  confidence  TEXT NOT NULL DEFAULT 'tentative'
              CHECK (confidence IN ('confirmed','firm','tentative')),
  claim       TEXT,
  reasons     TEXT NOT NULL DEFAULT '[]',
  artifact    TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(hunt_id, test_name)
);
CREATE INDEX IF NOT EXISTS idx_proofs_verdict ON proofs(verdict, created_at);

-- Distilled corpus digest, one row. ~151 KB, well under the 2 MB value cap.
-- The source corpus never enters the database; only this summary does.
CREATE TABLE IF NOT EXISTS corpus_digest (
  version      TEXT PRIMARY KEY,
  source_rows  INTEGER NOT NULL,
  digest       TEXT NOT NULL,
  loaded_at    INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────── learning (live) ────────
-- The corpus digest above is frozen opinion: 180,907 audit findings somebody
-- else labelled, shipped at build time. It never updates and it cannot say
-- whether THIS bot proves anything on THIS target.
--
-- learning_outcomes is the opposite: one row per executed proof attempt, with
-- the only ground truth the bot actually produces. The four verdicts come from
-- v2/src/proof.ts; only 'proven' is a real finding, and v1/src/learn.ts treats
-- it that way when it computes weights.
--
-- APPEND-ONLY BY CONVENTION. Nothing updates or deletes these rows; the whole
-- point is that the weight history is reconstructable. Idempotent by schema,
-- but a replayed attempt is a second row — dedupe on target_fingerprint if a
-- retry storm ever becomes a problem, do not delete.
CREATE TABLE IF NOT EXISTS learning_outcomes (
  id                 TEXT PRIMARY KEY,
  cls                TEXT NOT NULL,           -- playbook corpus class id
  playbook           TEXT NOT NULL,           -- playbook that produced it
  verdict            TEXT NOT NULL
                     CHECK (verdict IN ('proven','partial','disproved','inconclusive')),
  target_fingerprint TEXT,                    -- stable hash of the target
  measured_before    REAL,                    -- optional measured effect
  measured_after     REAL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_cls      ON learning_outcomes(cls, created_at);
CREATE INDEX IF NOT EXISTS idx_learning_playbook ON learning_outcomes(playbook, created_at);

-- Provenance for every corpus expansion. Required, not decorative: the digest
-- carries a CC BY 4.0 attribution obligation, and a merged digest with no
-- record of where the extra rows came from cannot satisfy it. One row per
-- (source, digest version) so a merge is auditable after the fact.
CREATE TABLE IF NOT EXISTS corpus_sources (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,                -- ghsa|nvd|cvelist|defihacklabs|jsonl...
  url           TEXT,                         -- where the rows came from
  licence       TEXT,                         -- SPDX id or explicit "none"
  rows_ingested INTEGER NOT NULL DEFAULT 0,
  digest_version TEXT,                        -- digest the rows landed in
  ingested_at   INTEGER NOT NULL,
  UNIQUE(source, digest_version)
);
CREATE INDEX IF NOT EXISTS idx_corpus_sources_src ON corpus_sources(source, ingested_at);

-- ══════════════════════════════════════════════════════════════════════
--   desk — the Solana paper-trading desk
--
--   Everything here is prefixed desk_ on purpose. Trading data must never
--   land in findings/evidence/probes: those tables are the security
--   product's record and its trust story depends on a "proven" finding
--   meaning an exploitable bug, not a token that happened to pump. The
--   ledger may receive desk audit lines (kind = 'desk.*') because that is
--   how the rest of the app records that something happened.
--
--   Mode lives in kv ('desk_mode'), never in a table column you can UPDATE
--   from a request handler. Live arming additionally needs two secrets that
--   only exist via `wrangler secret put`; see desk/arming.ts.
-- ══════════════════════════════════════════════════════════════════════

-- Scout output. One row per mint, updated in place: a mint we have seen
-- before is not a new universe entry, it is the same token with new numbers.
CREATE TABLE IF NOT EXISTS desk_universe (
  mint           TEXT PRIMARY KEY,
  symbol         TEXT,
  name           TEXT,
  pair_address   TEXT,
  dex            TEXT,
  pair_created_at INTEGER NOT NULL,           -- ms since epoch, from the pair
  first_seen     INTEGER NOT NULL,            -- seconds, our clock
  last_seen      INTEGER NOT NULL,
  mcap_usd       REAL NOT NULL DEFAULT 0,
  liq_usd        REAL NOT NULL DEFAULT 0,
  vol_1h_usd     REAL NOT NULL DEFAULT 0,
  vol_24h_usd    REAL NOT NULL DEFAULT 0,
  price_usd      REAL NOT NULL DEFAULT 0,
  price_6h_low   REAL NOT NULL DEFAULT 0,
  price_24h_low  REAL NOT NULL DEFAULT 0,
  holders        INTEGER NOT NULL DEFAULT 0,
  -- scout verdict: 'in' means the coarse gates passed. It is NOT a buy.
  state          TEXT NOT NULL DEFAULT 'in'
                 CHECK (state IN ('in','scored','passed','killed','expired')),
  snapshot       TEXT NOT NULL DEFAULT '{}'   -- raw DexScreener pair at scout time
);
CREATE INDEX IF NOT EXISTS idx_desk_universe_state ON desk_universe(state, last_seen);
CREATE INDEX IF NOT EXISTS idx_desk_universe_age   ON desk_universe(pair_created_at);

-- Filter + analyst output. One row per (mint, scored_at) so the score
-- history is reconstructable; the newest row for a mint is current.
CREATE TABLE IF NOT EXISTS desk_scores (
  id          TEXT PRIMARY KEY,
  mint        TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  total       REAL NOT NULL,
  subscores   TEXT NOT NULL,                  -- JSON {component: {raw, score, floor, weight}}
  floor_failed TEXT NOT NULL DEFAULT '[]',    -- JSON[] of components under their floor
  passed      INTEGER NOT NULL DEFAULT 0,     -- 1 only when total>=70 AND no floor_failed
  why         TEXT NOT NULL DEFAULT ''        -- the stored "why", not just messaged
);
CREATE INDEX IF NOT EXISTS idx_desk_scores_mint ON desk_scores(mint, ts DESC);

-- Every kill, with the reason code and the snapshot that justified it. This
-- table is the model: the weekly calibration report is computed from it.
CREATE TABLE IF NOT EXISTS desk_kills (
  id           TEXT PRIMARY KEY,
  mint         TEXT NOT NULL,
  symbol       TEXT,
  ts           INTEGER NOT NULL,
  reason       TEXT NOT NULL,                 -- stable code, see desk/reasons.ts
  detail       TEXT NOT NULL DEFAULT '',      -- human sentence, numbers inline
  snapshot     TEXT NOT NULL DEFAULT '{}',    -- the full input that produced the kill
  -- filled in later by calibration: did avoiding this token turn out wrong?
  outcome      TEXT NOT NULL DEFAULT 'unknown'
               CHECK (outcome IN ('unknown','dodged','missed_3x','missed_10x')),
  outcome_ts   INTEGER,
  outcome_price REAL
);
CREATE INDEX IF NOT EXISTS idx_desk_kills_ts     ON desk_kills(ts DESC);
CREATE INDEX IF NOT EXISTS idx_desk_kills_reason ON desk_kills(reason, ts DESC);

-- Open and closed paper positions. mode is recorded per position so a paper
-- run's statistics can never be mixed with a live one by accident.
CREATE TABLE IF NOT EXISTS desk_positions (
  id             TEXT PRIMARY KEY,
  mint           TEXT NOT NULL,
  symbol         TEXT,
  mode           TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','live')),
  opened_at      INTEGER NOT NULL,
  closed_at      INTEGER,
  entry_price    REAL NOT NULL,
  confirmation_price REAL,                    -- second-half entry, NULL until filled
  size_usd       REAL NOT NULL,               -- total intended position size
  filled_usd     REAL NOT NULL DEFAULT 0,
  qty            REAL NOT NULL DEFAULT 0,
  stop_price     REAL NOT NULL,
  peak_price     REAL NOT NULL,
  trail_armed    INTEGER NOT NULL DEFAULT 0,
  trail_pct      REAL NOT NULL DEFAULT 0.12,
  atr14          REAL NOT NULL DEFAULT 0,
  liq_at_entry   REAL NOT NULL,
  state          TEXT NOT NULL DEFAULT 'open'
                 CHECK (state IN ('open','closed')),
  exit_price     REAL,
  exit_reason    TEXT,                        -- reason code, see desk/reasons.ts
  pnl_usd        REAL,
  pnl_pct        REAL,
  thesis_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_desk_pos_open ON desk_positions(state, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_desk_pos_mint ON desk_positions(mint);

-- Every simulated (or, once armed, real) fill. Append-only: a fill is a
-- fact about what the model believed the book did, and rewriting one would
-- make the calibration report meaningless.
CREATE TABLE IF NOT EXISTS desk_fills (
  id           TEXT PRIMARY KEY,
  position_id  TEXT NOT NULL,
  mint         TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  side         TEXT NOT NULL CHECK (side IN ('buy','sell')),
  tranche      TEXT NOT NULL DEFAULT 'entry' CHECK (tranche IN ('entry','confirmation','exit','stop')),
  qty          REAL NOT NULL,
  price        REAL NOT NULL,
  notional_usd REAL NOT NULL,
  -- what paper mode modelled on top of the pool price. Zero for live fills,
  -- where the chain charged the real amount.
  lp_fee_usd   REAL NOT NULL DEFAULT 0,
  prio_fee_usd REAL NOT NULL DEFAULT 0,
  slippage_usd REAL NOT NULL DEFAULT 0,
  price_impact REAL NOT NULL DEFAULT 0,       -- fraction, e.g. 0.0042
  mode         TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','live'))
);
CREATE INDEX IF NOT EXISTS idx_desk_fills_pos ON desk_fills(position_id, ts);

-- Thesis prose. The LLM writes here and only here. The score and the size
-- live in desk_scores and desk_positions, so prose can never move them.
CREATE TABLE IF NOT EXISTS desk_theses (
  id         TEXT PRIMARY KEY,
  mint       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  source     TEXT NOT NULL DEFAULT 'deterministic'
             CHECK (source IN ('deterministic','llm','llm_failed')),
  score_id   TEXT,
  body       TEXT NOT NULL,
  model      TEXT
);
CREATE INDEX IF NOT EXISTS idx_desk_theses_mint ON desk_theses(mint, ts DESC);

-- Weekly calibration. Per reason code: how many kills, how many of those
-- tokens later 3x'd (a false negative) and how many went to -90% (a true
-- positive). A desk that logs but never calibrates is a journal.
CREATE TABLE IF NOT EXISTS desk_calibration (
  id            TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  window_start  INTEGER NOT NULL,
  window_end    INTEGER NOT NULL,
  rows          TEXT NOT NULL,                -- JSON[] per reason code
  totals        TEXT NOT NULL DEFAULT '{}',   -- JSON {kills, dodge_rate, ...}
  note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_desk_calib_ts ON desk_calibration(ts DESC);
