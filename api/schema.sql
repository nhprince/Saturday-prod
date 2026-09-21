-- Saturday — D1 schema.  wrangler d1 execute saturday --file=schema.sql --remote
-- Every statement is IF NOT EXISTS, so re-running this on an existing database
-- (e.g. after pulling an update that adds a table) is safe and idempotent.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'user',      -- user | admin
  status        TEXT NOT NULL DEFAULT 'active',    -- active | suspended
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  model_id    TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  role             TEXT NOT NULL,                  -- user | assistant
  content          TEXT NOT NULL,
  routing          TEXT,                           -- JSON RoutingDecision
  tokens_in        INTEGER,
  tokens_out       INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id               TEXT PRIMARY KEY,
  message_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  mime             TEXT,
  size_bytes       INTEGER,
  r2_key           TEXT,
  created_at       INTEGER NOT NULL
);

-- Admin-managed configuration that must never live in source code.
CREATE TABLE IF NOT EXISTS provider_config (
  provider_id  TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 1,
  priority     INTEGER NOT NULL DEFAULT 100,
  settings     TEXT,                              -- JSON
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_overrides (
  model_id     TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 1,
  priority     INTEGER NOT NULL DEFAULT 100,
  capabilities TEXT,                              -- JSON override
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_providers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  base_url     TEXT NOT NULL,
  api_key      TEXT NOT NULL,
  free_only    INTEGER NOT NULL DEFAULT 0,      -- 1: only list models the endpoint prices at $0
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_rules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  match_signal TEXT NOT NULL,                     -- e.g. 'vision' | 'reasoning'
  prefer_tier  TEXT,
  prefer_model TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  position     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cms_content (
  key          TEXT PRIMARY KEY,                  -- landing.hero, suggestions, announcement
  value        TEXT NOT NULL,                     -- JSON
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_flags (
  key          TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 0,
  rollout_pct  INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);
