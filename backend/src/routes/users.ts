import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import { query } from '../db';
import { authRequired, requireOrgRole, Role } from '../middleware/auth';
import { orgClause, orgForInsert } from '../services/scope';
import { sendEmail, userInviteEmail } from '../services/email';

const INVITE_TTL_HOURS = 7 * 24;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const router = Router();
router.use(authRequired);

const ASSIGNABLE_ROLES = ['org_admin', 'org_operator', 'org_viewer'] as const;

const usernameRule = z
  .string()
  .min(3)
  .max(60)
  .regex(/^[a-zA-Z0-9._-]+$/, 'invalid characters in username');

const passwordRule = z.string().min(8).max(200);

const createSchema = z.object({
  username: usernameRule,
  password: passwordRule,
  role: z.enum(ASSIGNABLE_ROLES),
});

const updateSchema = z
  .object({
    password: passwordRule.optional(),
    role: z.enum(ASSIGNABLE_ROLES).optional(),
  })
  .refine((d) => d.password !== undefined || d.role !== undefined, {
    message: 'must provide password or role',
  });

interface UserRow {
  id: string;
  username: string;
  role: Role;
  organization_id: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS = `id, username, role, organization_id, created_at, updated_at`;

router.get('/', requireOrgRole('org_admin'), async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 1);
  const { rows } = await query<UserRow>(
    `SELECT ${SELECT_COLS} FROM users WHERE 1=1 ${clause} ORDER BY username ASC`,
    params,
  );
  res.json(rows);
});

router.post('/', requireOrgRole('org_admin'), async (req, res) => {
  const data = createSchema.parse(req.body);
  const orgId = orgForInsert(req);

  const taken = await query(`SELECT 1 FROM users WHERE username = $1`, [data.username]);
  if (taken.rows.length > 0) {
    res.status(409).json({ error: 'username already taken' });
    return;
  }

  const hash = await bcrypt.hash(data.password, 10);
  const { rows } = await query<UserRow>(
    `INSERT INTO users (username, password_hash, role, organization_id)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SELECT_COLS}`,
    [data.username, hash, data.role, orgId],
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', requireOrgRole('org_admin'), async (req, res) => {
  const data = updateSchema.parse(req.body);

  // Confirm target is in scope (org_admin can only touch their own org;
  // super_admin acts within whichever org they've scoped to).
  const { clause, params } = orgClause(req, 'organization_id', 2);
  const exists = await query<{ id: string; role: Role }>(
    `SELECT id, role FROM users WHERE id = $1 ${clause}`,
    [req.params.id, ...params],
  );
  if (exists.rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // Refuse to demote yourself out of org_admin — at least one admin must remain
  // active in the org and self-demotion is the easiest way to lock yourself out.
  if (data.role && req.params.id === req.user!.sub && data.role !== 'org_admin') {
    res.status(400).json({ error: 'cannot change your own role away from org_admin' });
    return;
  }
  // Never allow assigning super_admin via this route, even if zod were bypassed.
  if (exists.rows[0].role === 'super_admin') {
    res.status(403).json({ error: 'cannot modify a super_admin via this endpoint' });
    return;
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (data.password !== undefined) {
    const hash = await bcrypt.hash(data.password, 10);
    sets.push(`password_hash = $${i++}`);
    values.push(hash);
  }
  if (data.role !== undefined) {
    sets.push(`role = $${i++}`);
    values.push(data.role);
  }
  sets.push(`updated_at = NOW()`);
  values.push(req.params.id);
  const { rows } = await query<UserRow>(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${SELECT_COLS}`,
    values,
  );
  res.json(rows[0]);
});

router.delete('/:id', requireOrgRole('org_admin'), async (req, res) => {
  if (req.params.id === req.user!.sub) {
    res.status(400).json({ error: 'cannot delete yourself' });
    return;
  }
  const { clause, params } = orgClause(req, 'organization_id', 2);
  const target = await query<{ id: string; role: Role }>(
    `SELECT id, role FROM users WHERE id = $1 ${clause}`,
    [req.params.id, ...params],
  );
  if (target.rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (target.rows[0].role === 'super_admin') {
    res.status(403).json({ error: 'cannot delete a super_admin via this endpoint' });
    return;
  }
  await query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});

// ---------- Invites ----------

const emailRule = z.string().email().max(200);

const inviteSchema = z.object({
  email: emailRule,
  role: z.enum(ASSIGNABLE_ROLES),
});

interface InviteRow {
  id: string;
  organization_id: string;
  email: string;
  role: Role;
  expires_at: string;
  created_by: string | null;
  created_at: string;
  accepted_at: string | null;
}

const INVITE_PUBLIC_COLS = `id, organization_id, email, role, expires_at, created_by, created_at, accepted_at`;

async function createAndSendInvite(opts: {
  orgId: string;
  email: string;
  role: Role;
  inviterId: string;
  inviterName: string;
  organizationName: string;
}): Promise<{ row: InviteRow; token: string }> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);

  const { rows } = await query<InviteRow>(
    `INSERT INTO user_invites (organization_id, email, role, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${INVITE_PUBLIC_COLS}`,
    [opts.orgId, opts.email.toLowerCase(), opts.role, tokenHash, expiresAt, opts.inviterId],
  );

  const tpl = userInviteEmail({
    inviterName: opts.inviterName,
    organizationName: opts.organizationName,
    role: opts.role,
    token,
    expiresAt,
  });
  await sendEmail({ to: opts.email, subject: tpl.subject, html: tpl.html, text: tpl.text });

  return { row: rows[0], token };
}

router.get('/invites', requireOrgRole('org_admin'), async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 1);
  const { rows } = await query<InviteRow>(
    `SELECT ${INVITE_PUBLIC_COLS} FROM user_invites
     WHERE accepted_at IS NULL ${clause}
     ORDER BY created_at DESC`,
    params,
  );
  res.json(rows);
});

router.post('/invites', requireOrgRole('org_admin'), async (req, res) => {
  const data = inviteSchema.parse(req.body);
  const orgId = orgForInsert(req);

  // Look up the org name for the email template.
  const orgRes = await query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
  if (orgRes.rows.length === 0) {
    res.status(400).json({ error: 'org not found' });
    return;
  }

  try {
    const { row } = await createAndSendInvite({
      orgId,
      email: data.email,
      role: data.role,
      inviterId: req.user!.sub,
      inviterName: req.user!.username,
      organizationName: orgRes.rows[0].name,
    });
    res.status(201).json(row);
  } catch (err) {
    // Unique-index violation = there's already a pending invite for this email
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'an invite for this email is already pending — revoke it first to send a new one' });
      return;
    }
    throw err;
  }
});

router.post('/invites/:id/resend', requireOrgRole('org_admin'), async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 2);
  const existing = await query<InviteRow>(
    `SELECT ${INVITE_PUBLIC_COLS} FROM user_invites
     WHERE id = $1 AND accepted_at IS NULL ${clause}`,
    [req.params.id, ...params],
  );
  if (existing.rows.length === 0) {
    res.status(404).json({ error: 'invite not found' });
    return;
  }
  const old = existing.rows[0];

  // Rotate the token + extend expiry, then re-send.
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);
  const { rows } = await query<InviteRow>(
    `UPDATE user_invites SET token_hash = $1, expires_at = $2
     WHERE id = $3 RETURNING ${INVITE_PUBLIC_COLS}`,
    [tokenHash, expiresAt, req.params.id],
  );

  const orgRes = await query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [old.organization_id]);
  const orgName = orgRes.rows[0]?.name ?? 'LED Server';
  const tpl = userInviteEmail({
    inviterName: req.user!.username,
    organizationName: orgName,
    role: old.role,
    token,
    expiresAt,
  });
  await sendEmail({ to: old.email, subject: tpl.subject, html: tpl.html, text: tpl.text });

  res.json(rows[0]);
});

router.delete('/invites/:id', requireOrgRole('org_admin'), async (req, res) => {
  const { clause, params } = orgClause(req, 'organization_id', 2);
  const { rowCount } = await query(
    `DELETE FROM user_invites WHERE id = $1 ${clause}`,
    [req.params.id, ...params],
  );
  if (rowCount === 0) {
    res.status(404).json({ error: 'invite not found' });
    return;
  }
  res.status(204).end();
});

export default router;
