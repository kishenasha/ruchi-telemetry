-- Why imports failed, aggregated by day and never by person. ruchi-ai has
-- always sent an error class with every usage record and this service has
-- always dropped it; this is where it lands now.
--
-- Deliberately has no user_hash column. A failure reason is a reliability
-- signal, and keying it to a person would turn it into a history of what
-- went wrong for them, which is not what any of this is for.
CREATE TABLE IF NOT EXISTS errors_daily (
  day         TEXT    NOT NULL,
  feature_id  TEXT    NOT NULL,
  plan        TEXT    NOT NULL,
  -- A class name, optionally with an HTTP status: HTTPError:429. Never a
  -- message, never anything a page or a prompt could have put in it.
  error_class TEXT    NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  first_seen  TEXT    NOT NULL,
  last_seen   TEXT    NOT NULL,
  PRIMARY KEY (day, feature_id, plan, error_class)
);

CREATE INDEX IF NOT EXISTS idx_errors_daily_day ON errors_daily (day);
