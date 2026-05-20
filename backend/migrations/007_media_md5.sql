-- VNNOX Media API requires lowercase MD5 alongside the SHA256 we already store.
-- New uploads compute it at insert time; existing rows are backfilled lazily
-- by the VNNOX client the first time they're pushed to a player.

ALTER TABLE media ADD COLUMN IF NOT EXISTS checksum_md5 TEXT;
