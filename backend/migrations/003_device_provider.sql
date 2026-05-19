-- Devices can be controlled via different transports:
--   'vnnox'      — NovaStar's VNNOX/NovaCloud Open Platform REST API (production default)
--   'lan_direct' — direct TCP to the controller on port 5200 (in-shop diagnostics only)
--   'mock'       — in-process mock (tests)
--
-- For 'vnnox', the `device_key` column holds the device serial number (SN) reported by
-- VNNOX. For 'lan_direct', it holds whatever local key the controller expects.

ALTER TABLE devices ADD COLUMN provider TEXT NOT NULL DEFAULT 'vnnox';

ALTER TABLE devices ADD CONSTRAINT devices_provider_check
  CHECK (provider IN ('vnnox', 'lan_direct', 'mock'));

-- Existing rows (registered before VNNOX integration) likely came from the
-- LAN-direct stub flow. Mark them as such; admins can change per-device.
UPDATE devices SET provider = 'lan_direct' WHERE provider = 'vnnox' AND created_at < NOW();

CREATE INDEX devices_provider_idx ON devices(organization_id, provider);
