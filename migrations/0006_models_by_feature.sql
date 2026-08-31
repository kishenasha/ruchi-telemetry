-- Models are chosen per feature now, not per plan: a photograph and a pasted
-- paragraph are not the same job as a scraped page, and each has to be
-- re-pointed on its own without dragging the others with it.
--
-- Recreated rather than altered. The table was empty at the time of this
-- migration (every row read as a shipped default), so there was nothing to
-- carry across, and a plan-keyed row has no single honest feature to become:
-- the old "pro" row drove smart_import for both tiers while "free" drove
-- quick_import.
DROP TABLE IF EXISTS models;

CREATE TABLE models (
  feature_id TEXT NOT NULL,
  plan       TEXT NOT NULL,
  model      TEXT NOT NULL,
  applied    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,

  PRIMARY KEY (feature_id, plan)
);
