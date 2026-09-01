-- An allowance can be switched off without losing the number it was set to.
--
-- Zero already turns a combination off, and still does: that is what gets
-- pushed to Upstash when a row is disabled, so ruchi-ai needs no change. What
-- this adds is somewhere to keep the real number meanwhile, so turning Photo's
-- trial off for a week and back on does not mean remembering it was 3.
ALTER TABLE limits ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
