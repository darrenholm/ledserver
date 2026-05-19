import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query, withTx } from '../db';
import { Role, signToken } from '../middleware/auth';

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

export default router;
