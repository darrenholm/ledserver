-- Two unrelated rental columns added together for tidiness:
--
-- 1. qbo_receipt_id: the QBO Sales Receipt ID created via shop-api after
--    each successful card charge. Stored for traceability so we can match
--    a rental against a QBO receipt without re-querying QBO.
--
-- 2. fit_mode: how the customer wants their artwork rendered on the
--    physical screen — 'contain' (letterbox, preserve aspect) or 'cover'
--    (stretch/crop to fill). Surfaced as "Fit as-is" vs "Stretch" on the
--    booking order page. Defaults to 'contain' so existing rows keep the
--    behaviour they had before this column existed.

ALTER TABLE rentals
  ADD COLUMN qbo_receipt_id TEXT,
  ADD COLUMN fit_mode TEXT NOT NULL DEFAULT 'contain';

ALTER TABLE rentals
  ADD CONSTRAINT rentals_fit_mode_check CHECK (fit_mode IN ('contain', 'cover'));
