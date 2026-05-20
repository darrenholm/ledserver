import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db';
import { authRequired, requireOrgRole, Role } from '../middleware/auth';
import { orgClause, orgForInsert } from '../services/scope';

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

export default router;
