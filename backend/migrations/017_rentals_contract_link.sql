-- Link each ad creative (rentals row) to its parent contract.
--
-- Backward-compatible nullable add:
--   contract_id NULL  → legacy one-shot self-serve booking (the
--                       existing /advertise public flow). No formal
--                       contract; the rental row is the whole story.
--   contract_id SET   → ad belongs to an ad_contracts row. Used for:
--                         - admin attribution of already-running ads
--                         - owner-operated screens (contract auto-created
--                           by the trigger in migration 016)
--                         - future bookings we group under a contract
--
-- ON DELETE SET NULL so cancelling a contract doesn't blow away the
-- historical ad record — we want to remember what ran.

ALTER TABLE rentals
  ADD COLUMN contract_id UUID REFERENCES ad_contracts(id) ON DELETE SET NULL;

CREATE INDEX rentals_contract_idx
  ON rentals(contract_id)
  WHERE contract_id IS NOT NULL;
