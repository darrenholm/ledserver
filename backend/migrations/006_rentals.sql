-- Ad-rental marketplace (Phase 1, Holm Graphics centrally).
--
-- A device flagged is_rentable shows up on the public /rent listing with its
-- day/week/month rates. Members of the public submit a rental request,
-- upload artwork, pay, and Holm Graphics approves before content is published.

ALTER TABLE devices
  ADD COLUMN is_rentable  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN daily_rate   NUMERIC(10, 2),    -- price per day, in your billing currency
  ADD COLUMN weekly_rate  NUMERIC(10, 2),
  ADD COLUMN monthly_rate NUMERIC(10, 2),
  ADD COLUMN rental_currency TEXT NOT NULL DEFAULT 'CAD';

CREATE INDEX devices_rentable_idx ON devices(is_rentable) WHERE is_rentable;

-- Statuses progress: pending_payment → pending_review → approved → active → expired
--                                                    ↘ rejected
--                                                    ↘ cancelled
CREATE TABLE rentals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id           UUID NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  status              TEXT NOT NULL DEFAULT 'pending_payment'
                        CHECK (status IN ('pending_payment','pending_review','approved','active','expired','rejected','cancelled')),

  -- Advertiser info (public submitter, not a registered user)
  advertiser_name     TEXT NOT NULL,
  advertiser_email    TEXT NOT NULL,
  advertiser_phone    TEXT,
  advertiser_business TEXT,
  advertiser_notes    TEXT,

  -- Booking window
  start_date          DATE NOT NULL,
  end_date            DATE NOT NULL,
  duration_unit       TEXT NOT NULL CHECK (duration_unit IN ('day','week','month')),
  duration_count      INTEGER NOT NULL CHECK (duration_count > 0),

  -- Money (in cents to avoid float weirdness)
  amount_cents        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'CAD',

  -- Payment tracking (Phase 1 stub; Phase 2 swaps in QuickBooks Payments)
  payment_provider    TEXT,                -- 'manual' | 'quickbooks' | …
  payment_reference   TEXT,                -- QB intent id, manual note, etc.
  paid_at             TIMESTAMPTZ,

  -- Artwork
  media_id            UUID REFERENCES media(id) ON DELETE SET NULL,
  artwork_warnings    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- e.g. ["aspect ratio mismatch"]

  -- Approval flow (signed token allows email click-to-approve without login)
  approval_token      TEXT NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  reviewed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  review_notes        TEXT,

  -- Lifecycle
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT rentals_dates_check CHECK (end_date >= start_date)
);

CREATE INDEX rentals_device_idx ON rentals(device_id, start_date);
CREATE INDEX rentals_status_idx ON rentals(status);
CREATE INDEX rentals_active_window_idx ON rentals(start_date, end_date) WHERE status IN ('approved','active');
