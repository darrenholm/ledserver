-- One-shot cleanup: delete orphaned synthetic rentals.
--
-- "Synthetic" rentals are the ones created by POST /api/ad-contracts/:id/
-- attach-media — bookkeeping rows that wrap an existing media file in a
-- rental record so it can be attributed to a contract. We stamp them with
-- advertiser_email='attributed@holmgraphics.ca' as a sentinel so we can
-- tell them apart from real /advertise bookings.
--
-- Before today's detach fix, clicking Detach on one of these just cleared
-- contract_id, leaving the rental row behind with no link to any contract.
-- The PlaylistDetail "ads on this playlist" query then found them via
-- media_id and rendered duplicate attribution rows.
--
-- The by-media and admin rentals queries now filter these out at read
-- time, but they still sit in the DB taking up an id and a row. This
-- migration purges them outright so a future query that forgets the
-- filter doesn't accidentally surface them again. Safe to re-run: the
-- next deploy applies this once, recorded in schema_migrations.

DO $$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH purged AS (
    DELETE FROM rentals
    WHERE contract_id IS NULL
      AND advertiser_email = 'attributed@holmgraphics.ca'
    RETURNING id
  )
  SELECT COUNT(*) INTO deleted_count FROM purged;
  RAISE NOTICE 'purged % orphaned synthetic rentals', deleted_count;
END $$;
