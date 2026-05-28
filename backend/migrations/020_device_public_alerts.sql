-- Per-device opt-in to overlay public-safety / weather alerts on screen.
--
-- Source feed: Environment Canada's GeoMet "active alerts" collection
-- (https://geo.weather.gc.ca/geomet/features/collections/wxo-active-alerts).
-- Public, CC-BY 4.0 licensed, returns GeoJSON polygons per alert. The
-- alerts service filters alerts to those whose polygon contains the
-- device's lat/lng (already stored from migration 005).
--
-- We deliberately default this OFF. Alerts interrupt the device's normal
-- programming, so this needs explicit admin consent per device (some
-- properties don't want emergency banners on their advertising; some
-- absolutely do). Default minimum severity is 'severe' — that suppresses
-- "special weather statement" noise but surfaces real tornado / blizzard
-- warnings.
--
-- Note re: Alert Ready (Pelmorex NAADS): the public broadcast Emergency
-- Alert system technically requires a license agreement for redistribution
-- to public displays. For now we only consume Environment Canada's CAP
-- feed, which is unambiguously public. If we ever want EM/AMBER alerts
-- too we'll need to talk to Pelmorex.

ALTER TABLE devices
  ADD COLUMN alerts_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'minor'   — special weather statements, advisories  (very chatty)
  -- 'moderate'— watches                                  (some noise)
  -- 'severe'  — warnings                                 (real impact only)
  -- 'extreme' — emergency-only (tornado warning, etc.)
  ADD COLUMN alerts_severity_min  TEXT NOT NULL DEFAULT 'severe',
  -- Tracking state: what we last successfully rendered on the device. Used
  -- to detect changes so we only republish VNNOX when the active alert
  -- actually flips (alert appears, alert clears, alert text changes).
  ADD COLUMN alerts_current_id    TEXT,
  ADD COLUMN alerts_current_text  TEXT,
  ADD COLUMN alerts_last_polled_at TIMESTAMPTZ;

ALTER TABLE devices
  ADD CONSTRAINT devices_alerts_severity_check
    CHECK (alerts_severity_min IN ('minor','moderate','severe','extreme'));
