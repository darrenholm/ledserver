-- Each rentable display has a fixed number of ad slots in the rotation.
-- A customer booking buys ONE slot for their dates+daypart window.
-- All active ads play in series alongside the base playlist (the device's
-- regular content rotation).

ALTER TABLE devices
  -- Maximum number of concurrent customer ads in the rotation. Booking
  -- requests beyond this are refused.
  ADD COLUMN max_ads INTEGER NOT NULL DEFAULT 8,

  -- Length (in seconds) of each ad slot in the rotation. Defaults to 6.
  -- This is what we show on the shop ("buy a 6-second slot").
  ADD COLUMN ad_slot_seconds INTEGER NOT NULL DEFAULT 6,

  -- The "regular content" playlist that runs when the device isn't
  -- showing an ad. When ads are publishing, this playlist still plays in
  -- between the ad slots. NULL means no base content (rare; for ad-only
  -- displays).
  ADD COLUMN base_playlist_id UUID REFERENCES playlists(id) ON DELETE SET NULL;

ALTER TABLE devices
  ADD CONSTRAINT devices_max_ads_check CHECK (max_ads >= 0 AND max_ads <= 64),
  ADD CONSTRAINT devices_slot_seconds_check CHECK (ad_slot_seconds BETWEEN 1 AND 60);
