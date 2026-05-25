import { Router } from 'express';
import { z } from 'zod';
import { authRequired, requireRole } from '../middleware/auth';
import { searchClientsViaShopApi, lookupClientViaShopApi, ShopApiError } from '../services/shopApiClient';

/**
 * Admin-only proxy to shop-api's client search. The LED app doesn't have
 * its own clients table — clients live in shop-api. This thin proxy keeps
 * the bridge secret server-side (the LED frontend never sees it) and
 * gives admin UIs a consistent /api/clients/search endpoint to call.
 *
 * Mounted at /api/clients.
 */
const router = Router();

router.use(authRequired);

const searchSchema = z.object({
  q: z.string().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

router.get('/search', requireRole('super_admin', 'org_admin'), async (req, res) => {
  const { q, limit } = searchSchema.parse(req.query);
  try {
    const clients = await searchClientsViaShopApi(q, limit);
    res.json({ clients });
  } catch (err) {
    if (err instanceof ShopApiError) {
      res.status(err.status === 503 ? 503 : 502).json({
        error: 'shop-api unreachable',
        message: err.message,
      });
      return;
    }
    throw err;
  }
});

// Single-client lookup by id. Used by admin pages that need to render
// "Foamtek" instead of "Client #7". Cheap server-side proxy so the
// browser never sees the bridge secret.
router.get('/:id', requireRole('super_admin', 'org_admin'), async (req, res) => {
  const idNum = parseInt(req.params.id, 10);
  if (!Number.isFinite(idNum)) {
    res.status(400).json({ error: 'id must be an integer' });
    return;
  }
  try {
    const client = await lookupClientViaShopApi(idNum);
    res.json(client);
  } catch (err) {
    if (err instanceof ShopApiError) {
      res.status(err.status === 503 ? 503 : err.status === 404 ? 404 : 502).json({
        error: err.status === 404 ? 'client not found' : 'shop-api unreachable',
        message: err.message,
      });
      return;
    }
    throw err;
  }
});

export default router;
