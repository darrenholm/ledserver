-- Automatic brightness scheduling based on sunrise/sunset for each device's
-- physical location. The scheduler service computes today's sun events from
-- (latitude, longitude) and transitions the device between brightness_day
-- and brightness_night around them.

ALTER TABLE devices
  ADD COLUMN auto_brightness_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN latitude               DECIMAL(9, 6),
  ADD COLUMN longitude              DECIMAL(9, 6),
  ADD COLUMN brightness_day         INTEGER NOT NULL DEFAULT 90 CHECK (brightness_day BETWEEN 0 AND 100),
  ADD COLUMN brightness_night       INTEGER NOT NULL DEFAULT 30 CHECK (brightness_night BETWEEN 0 AND 100),
  -- Positive = transition this many minutes AFTER sunrise/sunset; negative = before.
  -- e.g. -30 means start dimming 30 minutes before sunset.
  ADD COLUMN brightness_offset_minutes INTEGER NOT NULL DEFAULT 0,
  -- The last brightness value the scheduler successfully applied — used to
  -- avoid redundant API calls when nothing changed.
  ADD COLUMN last_applied_brightness  INTEGER,
  ADD COLUMN last_applied_at          TIMESTAMPTZ;

-- Partial index for the scheduler's per-tick scan (only enabled devices).
CREATE INDEX devices_auto_brightness_idx
  ON devices(organization_id) WHERE auto_brightness_enabled;
