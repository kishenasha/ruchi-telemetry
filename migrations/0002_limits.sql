-- The record of what each tier's limit is set to. Enforcement reads Upstash,
-- which both services already talk to on every request; this table is the
-- durable copy plus who changed it and when, so the dashboard can show the
-- current policy without asking Upstash to be the source of truth.
CREATE TABLE IF NOT EXISTS limits (
  feature_id TEXT NOT NULL,
  plan       TEXT NOT NULL,
  max_calls  INTEGER NOT NULL,
  period     TEXT NOT NULL,

  -- Whether the value actually reached Upstash. A limit that failed to push
  -- is shown as not applied rather than quietly displayed as if it were live.
  applied    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,

  PRIMARY KEY (feature_id, plan)
);
