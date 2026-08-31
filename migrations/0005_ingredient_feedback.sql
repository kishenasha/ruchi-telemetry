-- The unresolved-ingredient feedback loop, plan/14 section 14.2. Two
-- independent daily rollups, neither depending on the other: an occurrence
-- needs no correction to be worth reviewing, and a correction is a bonus
-- answer when a cook happens to give one.
--
-- corpus_version stays in the key on both: a name unresolved on version 12
-- and fixed by version 15 shipping the alias must not blend into one count,
-- or a past fix would be invisible in the numbers.
CREATE TABLE IF NOT EXISTS ingredient_unresolved_daily (
  day            TEXT    NOT NULL,
  ingredient     TEXT    NOT NULL,
  corpus_version INTEGER NOT NULL,
  source         TEXT    NOT NULL,
  count          INTEGER NOT NULL DEFAULT 0,
  first_seen     TEXT    NOT NULL,
  last_seen      TEXT    NOT NULL,
  PRIMARY KEY (day, ingredient, corpus_version, source)
);

CREATE INDEX IF NOT EXISTS idx_ingredient_unresolved_ingredient
  ON ingredient_unresolved_daily (ingredient);

CREATE TABLE IF NOT EXISTS ingredient_correction_daily (
  day            TEXT    NOT NULL,
  ingredient     TEXT    NOT NULL,
  corrected_to   TEXT    NOT NULL,
  corpus_version INTEGER NOT NULL,
  count          INTEGER NOT NULL DEFAULT 0,
  first_seen     TEXT    NOT NULL,
  last_seen      TEXT    NOT NULL,
  PRIMARY KEY (day, ingredient, corrected_to, corpus_version)
);

CREATE INDEX IF NOT EXISTS idx_ingredient_correction_ingredient
  ON ingredient_correction_daily (ingredient);
