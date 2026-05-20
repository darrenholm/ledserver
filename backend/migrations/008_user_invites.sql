-- Email-based user invites. The admin types an email + role; the server emails
-- a one-time link containing a random token. The invitee follows the link,
-- picks a username + password, and the user row is created at that point.
--
-- token_hash is the SHA256 of the token that lives in the email link, so a
-- leak of this table doesn't compromise live invites.

CREATE TABLE user_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('org_admin', 'org_operator', 'org_viewer')),
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at     TIMESTAMPTZ
);

CREATE INDEX user_invites_org_idx ON user_invites(organization_id);

-- One *open* invite per (org, email). After accept or revoke the row is removed
-- (or accepted_at is set), so re-inviting is fine. Admins who want to refresh
-- an outstanding invite revoke and re-create.
CREATE UNIQUE INDEX user_invites_open_uq
  ON user_invites(organization_id, lower(email))
  WHERE accepted_at IS NULL;
