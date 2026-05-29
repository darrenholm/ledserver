-- Self-service password reset.
--
-- /auth/forgot-password issues a single-use token, emails the user a
-- reset link, and stores the SHA-256 hash here. /auth/reset-password
-- looks the hash up, checks expiry + used_at, then bcrypts the new
-- password and stamps used_at = NOW().
--
-- Why store a hash, not the raw token: same reason we don't store
-- passwords plaintext. If the DB leaks, the active links in transit
-- can't be replayed (the attacker has to brute-force the 32-byte token
-- before the hour-long TTL elapses, which is intractable).
--
-- Indexes:
--   - token_hash is the lookup key on reset → unique + B-tree.
--   - user_id needed for the "invalidate all my open resets" sweep on
--     successful reset (so an attacker who phished one link can't reuse
--     a second open link).

CREATE TABLE password_resets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  -- Auditing — useful when investigating "did someone reset my account"
  -- tickets. Stored opportunistically; nullable so a missing header
  -- doesn't block the flow.
  ip_at_request TEXT,
  ip_at_use     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_password_resets_user_id ON password_resets(user_id);
