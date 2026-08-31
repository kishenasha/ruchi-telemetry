-- Which model each plan's imports run on, so it can be changed without an app
-- release or a redeploy. The services read the value from Upstash; this table
-- is the record of what was set and whether the push actually landed.
CREATE TABLE IF NOT EXISTS models (
  plan       TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  applied    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
