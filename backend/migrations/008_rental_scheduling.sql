-- Move ad-rental window scheduling from booking time to approval time.
--
-- Before: customer picked start_date at booking; window was set immediately.
--         If approval lagged, the customer "lost" days off the front.
-- After:  customer picks only the duration; start/end stay NULL until
--         Holm Graphics approves and schedules the actual run window.

ALTER TABLE rentals
  ALTER COLUMN start_date DROP NOT NULL,
  ALTER COLUMN end_date   DROP NOT NULL;

-- Cache the total duration in days for fast scheduling math (regardless of
-- whether the customer picked day/week/month). Computed once at booking time.
ALTER TABLE rentals ADD COLUMN duration_days INTEGER;

-- Backfill existing rows so old data still has a meaningful duration.
-- duration_unit + duration_count are the source of truth.
UPDATE rentals
   SET duration_days = CASE duration_unit
     WHEN 'day'   THEN duration_count
     WHEN 'week'  THEN duration_count * 7
     WHEN 'month' THEN duration_count * 30
     ELSE duration_count
   END
 WHERE duration_days IS NULL;

ALTER TABLE rentals ALTER COLUMN duration_days SET NOT NULL;
ALTER TABLE rentals ADD CONSTRAINT rentals_duration_days_positive CHECK (duration_days > 0);

-- The existing rentals_dates_check (end_date >= start_date) becomes wrong
-- when both can be NULL. Replace it with a conditional version that only
-- enforces ordering when both are set.
ALTER TABLE rentals DROP CONSTRAINT IF EXISTS rentals_dates_check;
ALTER TABLE rentals ADD CONSTRAINT rentals_dates_check CHECK (
  start_date IS NULL OR end_date IS NULL OR end_date >= start_date
);
