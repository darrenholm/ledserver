-- Marketing fields for the public ad-rental flow on holmgraphics.ca/advertise.
-- These show on the listing/detail pages so prospects can pick a display
-- based on location, photos, and reach.

ALTER TABLE devices
  ADD COLUMN photos        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN traffic_stat  TEXT,                          -- e.g. "Seen by ~50,000 vehicles/week"
  ADD COLUMN description   TEXT;                          -- one-paragraph display blurb for the listing

-- lat/lng already exist (added in 005_brightness_automation.sql) so the map
-- on holmgraphics.ca/advertise can plot displays without any further schema work.
