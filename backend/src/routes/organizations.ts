import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { authRequired, requireRole } from '../middleware/auth';

const router = Router();
router.use(authRequired);

// Local slugify — same shape as auth.ts's, kept inline to avoid pulling in
// the whole signup module. Hyphenate, lowercase, alpha-numeric only, capped
// at 60 chars so it stays URL-friendly.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
}

/**
 * Returns:
 *   - super_admin: every organization in the system
 *   - any org user: only their own organization (as a one-element array)
 */
router.get('/', async (req, res) => {
  if (req.user!.role === 'super_admin') {
    const { rows } = await query<OrgRow>(`SELECT * FROM organizations ORDER BY name ASC`);
    res.json(rows);
    return;
  }
  const { rows } = await query<OrgRow>(
    `SELECT * FROM organizations WHERE id = $1`,
    [req.user!.orgId],
  );
  res.json(rows);
});

router.get('/me', async (req, res) => {
  if (!req.user!.orgId) {
    res.status(404).json({ error: 'super_admin has no org' });
    return;
  }
  const { rows } = await query<OrgRow>(
    `SELECT * FROM organizations WHERE id = $1`,
    [req.user!.orgId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'org not found' });
    return;
  }
  res.json(rows[0]);
});

// --- super_admin-only management ---

const createSchema = z.object({
  name: z.string().min(2).max(120),
});

router.post('/', requireRole('super_admin'), async (req, res) => {
  const data = createSchema.parse(req.body);

  // Resolve a unique slug; same pattern as the signup flow uses.
  const slugBase = slugify(data.name) || 'org';
  let slug = slugBase;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const taken = await query(`SELECT 1 FROM organizations WHERE slug = $1`, [slug]);
    if (taken.rows.length === 0) break;
    slug = `${slugBase}-${suffix}`;
  }

  const { rows } = await query<OrgRow>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *`,
    [data.name, slug],
  );
  res.status(201).json(rows[0]);
});

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
});

router.patch('/:id', requireRole('super_admin'), async (req, res) => {
  const data = updateSchema.parse(req.body);
  if (data.name === undefined) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }
  const { rows } = await query<OrgRow>(
    `UPDATE organizations SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [data.name, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(rows[0]);
});

router.delete('/:id', requireRole('super_admin'), async (req, res) => {
  const { rowCount } = await query(`DELETE FROM organizations WHERE id = $1`, [req.params.id]);
  if (rowCount === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(204).end();
});

export default router;
