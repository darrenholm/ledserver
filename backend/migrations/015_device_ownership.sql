-- Screen ownership.
--
-- Most LED screens we install start as a sale: we create a job, fab the
-- screen, deliver it, and the client takes ownership. Those screens are
-- *theirs* — the ads on them are theirs to schedule and we don't bill
-- them per ad. They may also accept third-party rental ads sharing the
-- slots (mixed mode), so ownership and is_rentable are independent.
--
-- owner_client_id  → shop-api.clients.id (the company that owns the screen)
-- owner_project_id → shop-api.projects.id (the sale job that delivered it)
--
-- Both nullable: NULL = Holm Graphics owns the screen. Setting
-- owner_client_id triggers auto-creation of a perpetual ad_contracts row
-- (see migration 016) so the contracts→ads pipeline has a single code
-- path regardless of who owns the hardware.

ALTER TABLE devices
  ADD COLUMN owner_client_id  INTEGER,
  ADD COLUMN owner_project_id INTEGER;

CREATE INDEX devices_owner_client_idx
  ON devices(owner_client_id)
  WHERE owner_client_id IS NOT NULL;
