import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { query, withTx } from '../db';
import { authRequired, Role, signToken } from '../middleware/auth';

function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many login attempts, try again later' },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many signup attempts, try again later' },
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const signupSchema = z.object({
  organizationName: z.string().min(2).max(120),
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'invalid characters in username'),
  password: z.string().min(8).max(200),
});

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  organization_id: string | null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * SSO handoff from holmgraphics.ca's staff jobs board.
 *
 * The shop sidebar's "LED Screens" link forwards the logged-in employee's
 * shop-api staff JWT to us. We verify it with the shared secret (set via
 * SHOP_STAFF_JWT_SECRET — must equal shop-api's JWT_SECRET in production),
 * find-or-create a matching LED user with super_admin role, and issue a
 * LED-realm JWT that the LED frontend then uses normally.
 *
 * Auto-provisioning rationale: the shop staff list is the source of truth
 * for who works at Holm Graphics. Mirroring it manually in the LED users
 * table would mean keeping two lists in sync forever. Auto-create on first
 * SSO means a new hire who logs into the jobs board gets LED access for
 * free, and an off-boarded employee loses LED access the moment their
 * shop credentials are revoked (their JWT becomes unverifiable).
 *
 * Password for the auto-created user: a random 32-byte secret nobody knows.
 * The user can only sign in via SSO; direct /login is locked out by virtue
 * of the password being unguessable. If someone really needs a direct LED
 * login they can be added manually with bcrypt.
 */
const ssoFromShopSchema = z.object({
  shopToken: z.string().min(8).max(4000),
});

interface ShopStaffJwtPayload {
  // From shop-api/routes/auth.js — { id, email, role, name }
  id?: number;
  email?: string;
  role?: string;
  name?: string;
  // Customer tokens use realm='customer'; staff tokens don't carry one.
  realm?: string;
}

router.post('/sso-from-shop', loginLimiter, async (req, res) => {
  const { shopToken } = ssoFromShopSchema.parse(req.body);

  // Verify the shop JWT. If the secret doesn't match or the token is
  // expired/tampered, jwt.verify throws and we return 401.
  let decoded: ShopStaffJwtPayload;
  try {
    decoded = jwt.verify(shopToken, config.shopStaffJwt.secret) as ShopStaffJwtPayload;
  } catch {
    res.status(401).json({ error: 'invalid or expired shop token' });
    return;
  }

  // Reject customer-realm tokens — those don't grant staff access to the
  // LED admin. Customer auth has its own /api/public/my-rentals path.
  if (decoded.realm === 'customer') {
    res.status(403).json({ error: 'customer tokens cannot sign in to LED admin' });
    return;
  }

  // Reject the "client" role at shop-api too (that role exists for
  // client-portal users of the jobs board, not Holm Graphics staff).
  if (decoded.role === 'client') {
    res.status(403).json({ error: 'jobs-board client role cannot sign in to LED admin' });
    return;
  }

  if (!decoded.email) {
    res.status(400).json({ error: 'shop token missing email claim' });
    return;
  }

  // Username convention for SSO'd users: their shop email. Avoids collisions
  // with any manually-created LED users that picked a different username.
  const ssoUsername = decoded.email.trim().toLowerCase();

  // Find-or-create + ensure super_admin role.
  //
  // Policy: every shop staff member who SSOs in gets super_admin on the LED
  // app. That's the explicit ask — "allow all staff to access it at an admin
  // level." For existing LED users (e.g. an early manual setup with a lower
  // role) we PROMOTE them on next SSO so they don't have to file a ticket to
  // upload artwork. If you ever need to keep someone permanently scoped down,
  // remove their shop-api access — losing their staff JWT cuts SSO entirely.
  let userRow = (await query<UserRow>(
    `SELECT id, username, password_hash, role, organization_id
       FROM users WHERE username = $1`,
    [ssoUsername],
  )).rows[0];

  if (!userRow) {
    // Random unguessable password so direct /login can't be used for this
    // account — SSO is the only way in. 64-char hex = 256 bits of entropy.
    const randomSecret = crypto.randomBytes(32).toString('hex');
    const hash = await bcrypt.hash(randomSecret, 10);
    const inserted = await query<UserRow>(
      `INSERT INTO users (username, password_hash, role, organization_id)
       VALUES ($1, $2, 'super_admin', NULL)
       RETURNING id, username, password_hash, role, organization_id`,
      [ssoUsername, hash],
    );
    userRow = inserted.rows[0];
  } else if (userRow.role !== 'super_admin' || userRow.organization_id !== null) {
    // Existing user, but not at super_admin or scoped to an org. Promote
    // them and detach from the org so the rest of the app treats them
    // as a cross-tenant admin.
    const promoted = await query<UserRow>(
      `UPDATE users
          SET role = 'super_admin',
              organization_id = NULL,
              updated_at = NOW()
        WHERE id = $1
       RETURNING id, username, password_hash, role, organization_id`,
      [userRow.id],
    );
    userRow = promoted.rows[0];
  }

  const token = signToken({
    sub: userRow.id,
    username: userRow.username,
    role: userRow.role,
    orgId: userRow.organization_id,
  });
  res.json({
    token,
    user: {
      id: userRow.id,
      username: userRow.username,
      role: userRow.role,
      organizationId: userRow.organization_id,
    },
  });
});

/**
 * Tiny "who am I" diagnostic. Returns the JWT identity + a fresh DB read
 * of the user's role. Useful when an admin reports a permissions error
 * and we want to confirm "is your JWT stale, or is your DB record wrong"
 * without poking at localStorage in the browser.
 */
router.get('/me', authRequired, async (req, res) => {
  const { rows } = await query<{ id: string; username: string; role: Role; organization_id: string | null }>(
    `SELECT id, username, role, organization_id FROM users WHERE id = $1`,
    [req.user!.sub],
  );
  res.json({
    jwt: {
      sub: req.user!.sub,
      username: req.user!.username,
      role: req.user!.role,
      orgId: req.user!.orgId,
    },
    db: rows[0] ?? null,
    stale: rows[0] ? (rows[0].role !== req.user!.role || rows[0].organization_id !== req.user!.orgId) : false,
  });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = loginSchema.parse(req.body);
  const { rows } = await query<UserRow>(
    `SELECT id, username, password_hash, role, organization_id FROM users WHERE username = $1`,
    [username],
  );
  if (rows.length === 0) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  const token = signToken({
    sub: user.id,
    username: user.username,
    role: user.role,
    orgId: user.organization_id,
  });
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      organizationId: user.organization_id,
    },
  });
});

router.post('/signup', signupLimiter, async (req, res) => {
  const { organizationName, username, password } = signupSchema.parse(req.body);

  // Pre-check for uniqueness so we can return a clean 409 instead of a Postgres error.
  const usernameTaken = await query(`SELECT 1 FROM users WHERE username = $1`, [username]);
  if (usernameTaken.rows.length > 0) {
    res.status(409).json({ error: 'username already taken' });
    return;
  }

  const slugBase = slugify(organizationName) || 'org';
  // Resolve a unique slug.
  let slug = slugBase;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const taken = await query(`SELECT 1 FROM organizations WHERE slug = $1`, [slug]);
    if (taken.rows.length === 0) break;
    slug = `${slugBase}-${suffix}`;
  }

  const created = await withTx(async (client) => {
    const orgResult = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [organizationName, slug],
    );
    const orgId = orgResult.rows[0].id;
    const hash = await bcrypt.hash(password, 10);
    const userResult = await client.query<UserRow>(
      `INSERT INTO users (username, password_hash, role, organization_id)
       VALUES ($1, $2, 'org_admin', $3)
       RETURNING id, username, password_hash, role, organization_id`,
      [username, hash, orgId],
    );
    return { user: userResult.rows[0], orgId, slug };
  });

  const token = signToken({
    sub: created.user.id,
    username: created.user.username,
    role: created.user.role,
    orgId: created.user.organization_id,
  });
  res.status(201).json({
    token,
    user: {
      id: created.user.id,
      username: created.user.username,
      role: created.user.role,
      organizationId: created.user.organization_id,
    },
    organization: {
      id: created.orgId,
      name: organizationName,
      slug: created.slug,
    },
  });
});

// ---------- Public invite acceptance ----------

const acceptInviteSchema = z.object({
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'invalid characters in username'),
  password: z.string().min(8).max(200),
});

interface InviteLookupRow {
  id: string;
  organization_id: string;
  email: string;
  role: Role;
  expires_at: string;
  accepted_at: string | null;
  org_name: string;
}

async function loadInvite(token: string): Promise<InviteLookupRow | null> {
  const tokenHash = hashInviteToken(token);
  const { rows } = await query<InviteLookupRow>(
    `SELECT i.id, i.organization_id, i.email, i.role, i.expires_at, i.accepted_at,
            o.name AS org_name
     FROM user_invites i
     JOIN organizations o ON o.id = i.organization_id
     WHERE i.token_hash = $1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

router.get('/invite/:token', async (req, res) => {
  const invite = await loadInvite(req.params.token);
  if (!invite) {
    res.status(404).json({ error: 'invite not found' });
    return;
  }
  if (invite.accepted_at) {
    res.status(410).json({ error: 'invite already accepted' });
    return;
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    res.status(410).json({ error: 'invite has expired — ask the admin to resend' });
    return;
  }
  res.json({
    email: invite.email,
    role: invite.role,
    organizationName: invite.org_name,
    expiresAt: invite.expires_at,
  });
});

router.post('/invite/:token/accept', async (req, res) => {
  const data = acceptInviteSchema.parse(req.body);
  const invite = await loadInvite(req.params.token);
  if (!invite) {
    res.status(404).json({ error: 'invite not found' });
    return;
  }
  if (invite.accepted_at) {
    res.status(410).json({ error: 'invite already accepted' });
    return;
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    res.status(410).json({ error: 'invite has expired — ask the admin to resend' });
    return;
  }

  const taken = await query(`SELECT 1 FROM users WHERE username = $1`, [data.username]);
  if (taken.rows.length > 0) {
    res.status(409).json({ error: 'username already taken' });
    return;
  }

  const created = await withTx(async (client) => {
    const hash = await bcrypt.hash(data.password, 10);
    const userResult = await client.query<UserRow>(
      `INSERT INTO users (username, password_hash, role, organization_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, password_hash, role, organization_id`,
      [data.username, hash, invite.role, invite.organization_id],
    );
    await client.query(
      `UPDATE user_invites SET accepted_at = NOW() WHERE id = $1`,
      [invite.id],
    );
    return userResult.rows[0];
  });

  const token = signToken({
    sub: created.id,
    username: created.username,
    role: created.role,
    orgId: created.organization_id,
  });
  res.status(201).json({
    token,
    user: {
      id: created.id,
      username: created.username,
      role: created.role,
      organizationId: created.organization_id,
    },
  });
});

export default router;
