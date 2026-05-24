-- Time-of-day window for each rental. The ad plays daily between start_time
-- and end_time across the run window (start_date → end_date).
--
-- All-day (00:00:00 → 23:59:59) preserves the original behaviour, so existing
-- rows don't change shape from a customer perspective.

ALTER TABLE rentals
  ADD COLUMN start_time TIME NOT NULL DEFAULT '00:00:00',
  ADD COLUMN end_time   TIME NOT NULL DEFAULT '23:59:59';

-- Sanity: don't allow a window that ends before it starts. For v1 we don't
-- support overnight wrap-around (e.g. 10pm → 2am) — customers can just book
-- two adjacent dayparts if they really need that.
ALTER TABLE rentals ADD CONSTRAINT rentals_daypart_check CHECK (end_time > start_time);
