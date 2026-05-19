import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db';
import { signToken } from '../middleware/auth';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'operator' | 'viewer';
}

router.post('/login', async (req, res) => {
  const { username, password } = loginSchema.parse(req.body);
  const { rows } = await query<UserRow>(
    `SELECT id, username, password_hash, role FROM users WHERE username = $1`,
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
  const token = signToken({ sub: user.id, username: user.username, role: user.role });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

export default router;
