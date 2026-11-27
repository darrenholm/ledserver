-- Daily "off hours": the screen is turned off (VNNOX screen-status CLOSE)
-- between screen_off_start and screen_off_end, local time in screen_off_tz.
-- A window that crosses midnight (e.g. 23:30 -> 06:00) is supported.

ALTER TABLE devices
  ADD COLUMN screen_off_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN screen_off_start     TIME,
  ADD COLUMN screen_off_end       TIME,
  ADD COLUMN screen_off_tz        TEXT NOT NULL DEFAULT 'America/Toronto',
  -- What the scheduler last sent: 'OPEN' or 'CLOSE'. NULL = never sent.
  ADD COLUMN last_screen_power    TEXT CHECK (last_screen_power IN ('OPEN', 'CLOSE')),
  ADD COLUMN last_screen_power_at TIMESTAMPTZ;
