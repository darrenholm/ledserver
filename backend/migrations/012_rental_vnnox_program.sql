-- When an ad is approved we publish it as an "insertion program" on the
-- VNNOX device. NovaStar returns a program ID — we store it so we can
-- remove the program when the rental expires or gets rejected after the
-- fact, and so we can avoid double-publishing if approval is retried.

ALTER TABLE rentals
  ADD COLUMN vnnox_program_id TEXT,
  ADD COLUMN published_at     TIMESTAMPTZ,
  ADD COLUMN publish_error    TEXT;

-- Index for the nightly expiry/cleanup cron.
CREATE INDEX IF NOT EXISTS rentals_end_date_status_idx
  ON rentals(end_date, status)
  WHERE status IN ('approved', 'active');
