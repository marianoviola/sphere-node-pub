-- Sphere Node initial schema.
-- Applied with: wrangler d1 migrations apply SPHERE_DB [--local|--remote]

-- Fragment catalog. One row per published fragment. The full manifest is kept
-- as JSON so the node can reconstruct sphere.json without a second store, while
-- hot columns are denormalized for discovery and gating.
CREATE TABLE IF NOT EXISTS fragments (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  policy        TEXT NOT NULL,
  license       TEXT,
  manifest_json TEXT NOT NULL,
  content_key   TEXT NOT NULL,
  created_ts    INTEGER NOT NULL,
  updated_ts    INTEGER NOT NULL
);

-- Privacy-lean event ledger. One row per public request. No IP, no full
-- user-agent, no PII. fragment_id is NULL for discovery events.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  fragment_id TEXT,
  event_type  TEXT NOT NULL,
  ua_family   TEXT,
  ref_source  TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_fragment_ts ON events (fragment_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (event_type, ts);

-- Payment ledger. Dormant in v1: the shape exists, but the node never writes
-- rows until real payment verification is implemented.
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  fragment_id TEXT,
  amount      REAL NOT NULL DEFAULT 0,
  currency    TEXT,
  profile     TEXT,
  receipt     TEXT,
  status      TEXT NOT NULL DEFAULT 'none'
);

CREATE INDEX IF NOT EXISTS idx_payments_fragment_ts ON payments (fragment_id, ts);
