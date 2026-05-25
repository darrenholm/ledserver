-- Per-device overlay widgets on the BASE program (the device's normal
-- content rotation, not customer ad slots). NovaStar/VNNOX supports a
-- clock and a weather widget as small overlays layered above the
-- regular content. We let the device owner pick whether each is on,
-- where it sits, and (for weather) which location to display.
--
-- Positions are stored as TEXT enums so we can render them either as
-- corner anchors in our admin UI or as concrete VNNOX coordinates at
-- publish time. Default = top-right (least likely to clash with most
-- ad layouts, which usually anchor copy to the bottom-left).

ALTER TABLE devices
  ADD COLUMN overlay_clock_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN overlay_clock_position    TEXT NOT NULL DEFAULT 'top-right',
  ADD COLUMN overlay_clock_format      TEXT NOT NULL DEFAULT '12h',
  ADD COLUMN overlay_weather_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN overlay_weather_position  TEXT NOT NULL DEFAULT 'top-left',
  ADD COLUMN overlay_weather_location  TEXT,   -- city name or "lat,lng"; nullable until set
  ADD COLUMN overlay_weather_units     TEXT NOT NULL DEFAULT 'metric';

ALTER TABLE devices
  ADD CONSTRAINT devices_clock_position_check  CHECK (overlay_clock_position IN ('top-left','top-right','bottom-left','bottom-right')),
  ADD CONSTRAINT devices_weather_position_check CHECK (overlay_weather_position IN ('top-left','top-right','bottom-left','bottom-right')),
  ADD CONSTRAINT devices_clock_format_check    CHECK (overlay_clock_format IN ('12h','24h')),
  ADD CONSTRAINT devices_weather_units_check   CHECK (overlay_weather_units IN ('metric','imperial'));
