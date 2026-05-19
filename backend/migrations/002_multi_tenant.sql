-- Multi-tenancy: organizations + per-tenant scoping for devices/playlists/media.
-- Existing single-tenant data is assigned to a default "Holm Graphics" org.
-- The previously-seeded admin user becomes a super_admin (org_id NULL).

CREATE TABLE organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the internal org for existing data.
INSERT INTO organizations (name, slug) VALUES ('Holm Graphics', 'holmgraphics');

-- Widen the role check on users; allow NULL organization_id for super-admins.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users
  ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  ADD CONSTRAINT users_role_check
    CHECK (role IN ('super_admin', 'org_admin', 'org_operator', 'org_viewer'));

-- Existing role values: anything that was 'admin' becomes 'super_admin' with NULL org.
UPDATE users SET role = 'super_admin', organization_id = NULL
  WHERE role IN ('admin');
UPDATE users SET role = 'org_operator'
  WHERE role IN ('operator');
UPDATE users SET role = 'org_viewer'
  WHERE role IN ('viewer');

-- Super-admins (NULL org) and org users (non-null org) need different constraints:
-- super_admin → org_id IS NULL ; everyone else → org_id IS NOT NULL
ALTER TABLE users ADD CONSTRAINT users_org_role_check CHECK (
  (role = 'super_admin' AND organization_id IS NULL)
  OR (role <> 'super_admin' AND organization_id IS NOT NULL)
);

CREATE INDEX users_org_idx ON users(organization_id);

-- All tenant-scoped resources get organization_id (NOT NULL after backfill).
DO $$
DECLARE
  default_org UUID;
BEGIN
  SELECT id INTO default_org FROM organizations WHERE slug = 'holmgraphics';

  ALTER TABLE devices ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
  UPDATE devices SET organization_id = default_org;
  ALTER TABLE devices ALTER COLUMN organization_id SET NOT NULL;
  CREATE INDEX devices_org_idx ON devices(organization_id);

  ALTER TABLE playlists ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
  UPDATE playlists SET organization_id = default_org;
  ALTER TABLE playlists ALTER COLUMN organization_id SET NOT NULL;
  CREATE INDEX playlists_org_idx ON playlists(organization_id);

  ALTER TABLE media ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
  UPDATE media SET organization_id = default_org;
  ALTER TABLE media ALTER COLUMN organization_id SET NOT NULL;
  CREATE INDEX media_org_idx ON media(organization_id);
END $$;

-- device_key uniqueness should be per-org, not global (two customers might
-- claim the same key only if they actually have the same physical device).
ALTER TABLE devices DROP CONSTRAINT devices_device_key_key;
ALTER TABLE devices ADD CONSTRAINT devices_org_device_key_unique UNIQUE (organization_id, device_key);

-- logs can stay global (system events have no org) but record one for filtering.
ALTER TABLE logs ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX logs_org_idx ON logs(organization_id);
