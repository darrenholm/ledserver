-- Double-sided / side-by-side screens: the controller drives one wide canvas
-- made of two equal halves mapped left/right (e.g. two 360x120 faces = one
-- 720x120 canvas). When dual_panel is true, the publisher duplicates each
-- content slide onto both halves so a per-face image fills each face instead
-- of being stretched across the full width.
ALTER TABLE devices ADD COLUMN dual_panel BOOLEAN NOT NULL DEFAULT FALSE;
