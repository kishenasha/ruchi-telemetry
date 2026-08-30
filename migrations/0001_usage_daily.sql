-- One row per day per person per feature, not one row per call. The rollup is
-- the whole point: it answers week/month/year totals, which the ephemeral
-- Upstash counters in ruchi-ai structurally cannot, while staying small.
CREATE TABLE IF NOT EXISTS usage_daily (
  day              TEXT    NOT NULL,
  user_hash        TEXT    NOT NULL,
  feature_id       TEXT    NOT NULL,
  plan             TEXT    NOT NULL,

  request_count    INTEGER NOT NULL DEFAULT 0,
  error_count      INTEGER NOT NULL DEFAULT 0,

  -- Integer microdollars, never a float, matching ruchi-ai's money.py.
  cost_usd_micros  INTEGER NOT NULL DEFAULT 0,
  -- A call whose cost the provider did not report adds nothing to the sum
  -- above. Counting those separately keeps "spend so far" honest rather
  -- than letting an unknown quietly read as zero.
  cost_known_count INTEGER NOT NULL DEFAULT 0,

  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  latency_ms_total INTEGER NOT NULL DEFAULT 0,

  first_seen       TEXT    NOT NULL,
  last_seen        TEXT    NOT NULL,

  PRIMARY KEY (day, user_hash, feature_id, plan)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily (day);
CREATE INDEX IF NOT EXISTS idx_usage_daily_user ON usage_daily (user_hash);
