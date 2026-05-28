-- Full-screen weather widget as a rotation slot.
--
-- Different from overlay_weather_enabled (migration 014) which renders a
-- small corner widget on top of regular content. This one slots a whole
-- page into the device's base rotation — the same look as NovaStar's
-- "Basic Weather" widget template (full-screen sky background, large
-- temperature, location, condition icon, today's high/low).
--
-- The page sits at the END of the base playlist rotation, so customers'
-- regular content + ads come first, then a weather page, then back to
-- the start. Duration defaults to 8 seconds — long enough for someone
-- driving past to read but short enough not to feel like dead air.
--
-- Available to any client who owns a device (owner_perpetual contract)
-- or who has an active rental contract — exposed in /advertise/my-ads
-- as a self-serve toggle.

ALTER TABLE devices
  ADD COLUMN weather_page_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN weather_page_duration_ms   INTEGER NOT NULL DEFAULT 8000,
  -- Optional explicit location string (city name or "lat,lng"). Falls
  -- back to overlay_weather_location, then to devices.latitude/longitude.
  -- Lets a customer who runs their ad on a screen in another city show
  -- their own city's weather instead of the screen's location.
  ADD COLUMN weather_page_location      TEXT;

ALTER TABLE devices
  ADD CONSTRAINT devices_weather_page_duration_check
    CHECK (weather_page_duration_ms >= 3000 AND weather_page_duration_ms <= 60000);
