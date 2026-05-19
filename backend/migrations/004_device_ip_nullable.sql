-- VNNOX-provider devices don't have a LAN IP — they're controlled via NovaStar's
-- cloud, not directly. Allow NULL so we can register them.

ALTER TABLE devices ALTER COLUMN ip_address DROP NOT NULL;
