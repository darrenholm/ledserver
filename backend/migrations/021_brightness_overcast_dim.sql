-- Optional per-device brightness reduction during overcast weather.
--
-- The brightness scheduler (migration 005) already adjusts between
-- brightness_day and brightness_night based on sunrise/sunset. This
-- adds a second modulation: on cloudy days the LED panel is too bright
-- (because the sun isn't there to wash it out), so we knock it down
-- by a percentage proportional to current cloud cover.
--
-- Formula:
--   reduction_pct = (cloud_cover_pct / 100) * dim_max_pct
--   effective_brightness = scheduled_brightness * (1 - reduction_pct/100)
--
-- Example with default dim_max_pct=15:
--   Cloud cover  0%  → no reduction
--   Cloud cover 50%  → 7.5% reduction (75 → ~69)
--   Cloud cover 100% → 15% reduction (75 → ~64)
--
-- Cloud cover is pulled from Open-Meteo (free, no key) every brightness
-- tick. Default OFF — admin opts in per device, since some properties
-- (transit, public safety) want fixed brightness regardless of weather.

ALTER TABLE devices
  ADD COLUMN dim_on_overcast_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Maximum reduction (in percentage points off the scheduled brightness)
  -- when cloud cover is 100%. Capped at 30 to keep the panel readable.
  ADD COLUMN dim_max_pct              SMALLINT NOT NULL DEFAULT 15,
  -- Diagnostic: what the scheduler last computed. Useful for "why is my
  -- screen dim?" inspection without spelunking through logs.
  ADD COLUMN last_cloud_cover_pct     SMALLINT,
  ADD COLUMN last_dim_applied_pct     SMALLINT;

ALTER TABLE devices
  ADD CONSTRAINT devices_dim_max_pct_check
    CHECK (dim_max_pct >= 0 AND dim_max_pct <= 30);
