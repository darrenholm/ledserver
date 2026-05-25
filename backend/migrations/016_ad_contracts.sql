-- Advertising contracts — the commercial agreement layer.
--
-- Sits between the client (shop-api.clients) and the actual ad creatives
-- (rentals). One contract groups any number of ad creatives that ran
-- under the same agreement, so a client can swap their artwork mid-term
-- without us spawning a new "rental" each time, and we have a clean
-- record of "what did Foamtek run during 2026?".
--
-- contract_type:
--   'rental'           Third-party advertiser paying for a slot on a
--                      screen we own. Has a fixed term, an amount, and
--                      optionally auto_renew.
--   'owner_perpetual'  The client owns the screen (devices.owner_client_id
--                      points at them). Auto-created by trigger below
--                      when ownership is set. No end_date, no amount,
--                      never invoiced, never renewed.
--
-- The renewal cron scans THIS table, not rentals — that's the whole
-- point of the contract layer.

CREATE TABLE ad_contracts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             INTEGER NOT NULL,
  device_id             UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  contract_type         TEXT NOT NULL DEFAULT 'rental'
                          CHECK (contract_type IN ('rental','owner_perpetual')),
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','expired','cancelled')),

  -- Term window
  start_date            DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date              DATE,                  -- NULL for owner_perpetual
  term_unit             TEXT
                          CHECK (term_unit IS NULL OR term_unit IN ('day','week','month','year')),
  term_count            INTEGER
                          CHECK (term_count IS NULL OR term_count > 0),

  -- Money (cents to dodge float weirdness)
  amount_cents          INTEGER,               -- per-term price; NULL for owner_perpetual
  currency              TEXT NOT NULL DEFAULT 'CAD',

  -- Auto-renew + invoice bookkeeping. The renewal cron looks here,
  -- mints a QBO invoice via shop-api, and stamps the id + timestamp
  -- so the same term never gets invoiced twice.
  auto_renew            BOOLEAN NOT NULL DEFAULT FALSE,
  renewal_invoice_id    TEXT,
  renewal_invoiced_at   TIMESTAMPTZ,

  -- Optional override of the client's primary email — useful when the
  -- billing contact for ads is different from the main client contact.
  billing_contact_email TEXT,

  notes                 TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ad_contracts_dates_check CHECK (
    end_date IS NULL OR end_date >= start_date
  ),
  -- Owner-perpetual rows MUST be open-ended and not billable. Belt and
  -- suspenders so a UI bug can't turn an ownership row into an invoice.
  CONSTRAINT ad_contracts_owner_no_billing CHECK (
    contract_type <> 'owner_perpetual' OR (
      end_date IS NULL
        AND amount_cents IS NULL
        AND auto_renew = FALSE
    )
  )
);

CREATE INDEX ad_contracts_client_idx ON ad_contracts(client_id);
CREATE INDEX ad_contracts_device_idx ON ad_contracts(device_id);

-- Renewal cron's hot path: "active rental contracts due within N days
-- that haven't been invoiced yet." Partial index keeps it tiny.
CREATE INDEX ad_contracts_renewal_due_idx
  ON ad_contracts(end_date)
  WHERE auto_renew = TRUE
    AND renewal_invoiced_at IS NULL
    AND status = 'active';

-- Auto-create the owner_perpetual contract when devices.owner_client_id
-- is set (insert or update). Idempotent: only fires if no active
-- owner_perpetual contract exists for this device+client combination.
-- That keeps the (contracts → ads) read path single-code regardless of
-- whether the screen is owned or rented.
CREATE OR REPLACE FUNCTION devices_sync_owner_contract() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.owner_client_id IS NOT NULL THEN
    INSERT INTO ad_contracts (
      client_id, device_id, contract_type,
      start_date, end_date, amount_cents, auto_renew, notes
    )
    SELECT
      NEW.owner_client_id, NEW.id, 'owner_perpetual',
      CURRENT_DATE, NULL, NULL, FALSE,
      'Auto-created when device ownership was assigned.'
    WHERE NOT EXISTS (
      SELECT 1 FROM ad_contracts
       WHERE device_id = NEW.id
         AND client_id = NEW.owner_client_id
         AND contract_type = 'owner_perpetual'
         AND status = 'active'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER devices_sync_owner_contract_trg
  AFTER INSERT OR UPDATE OF owner_client_id ON devices
  FOR EACH ROW
  EXECUTE FUNCTION devices_sync_owner_contract();
