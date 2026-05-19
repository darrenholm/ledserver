import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { authRequired } from '../middleware/auth';

const router = Router();
router.use(authRequired);

const querySchema = z.object({
  deviceId: z.string().uuid().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().datetime().optional(),
});

router.get('/', async (req, res) => {
  const params = querySchema.parse(req.query);
  const filters: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (params.deviceId) { filters.push(`device_id = $${i++}`); values.push(params.deviceId); }
  if (params.level) { filters.push(`level = $${i++}`); values.push(params.level); }
  if (params.before) { filters.push(`ts < $${i++}`); values.push(params.before); }
  if (req.orgScope) { filters.push(`organization_id = $${i++}`); values.push(req.orgScope); }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  values.push(params.limit);
  const { rows } = await query(
    `SELECT id, ts, level, source, device_id, message, details
       FROM logs ${where}
      ORDER BY ts DESC
      LIMIT $${i}`,
    values,
  );
  res.json(rows);
});

export default router;
