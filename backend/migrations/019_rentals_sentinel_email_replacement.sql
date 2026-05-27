-- Replace the old synthetic-rental sentinel email with a client-scoped
-- placeholder.
--
-- Before today: rentals created via POST /api/ad-contracts/:id/attach-media
-- got stamped with advertiser_email='attributed@holmgraphics.ca'. That
-- string looked like a real Holm Graphics inbox in admin UIs and confused
-- everyone reading it.
--
-- New behaviour (in code): attach-media looks the contract's client up via
-- shop-api and stamps the rental with the actual client email. If shop-api
-- is unreachable, the rental gets a placeholder like
-- 'client-7@led.local' (unambiguously internal).
--
-- This migration retro-fits existing rows so the old sentinel disappears.
-- Where the rental has a contract, we use the contract's client_id; where
-- it doesn't (shouldn't happen — those are zombies — but defensive), we
-- fall back to 'orphaned@led.local' so the value at least isn't misleading.
--
-- Synthetic-rental detection has switched to (amount_cents=0 AND
-- payment_provider IS NULL), so we no longer depend on the email value to
-- identify synthetics. Safe to rewrite freely.

UPDATE rentals r
   SET advertiser_email = CASE
         WHEN c.client_id IS NOT NULL
           THEN 'client-' || c.client_id || '@led.local'
         ELSE 'orphaned@led.local'
       END,
       updated_at = NOW()
  FROM ad_contracts c
 WHERE r.advertiser_email = 'attributed@holmgraphics.ca'
   AND c.id = r.contract_id;

-- Catch any orphans (no contract_id) too.
UPDATE rentals
   SET advertiser_email = 'orphaned@led.local',
       updated_at = NOW()
 WHERE advertiser_email = 'attributed@holmgraphics.ca';
