import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { authRequired, requireRole } from '../middleware/auth';
import { orgClause } from '../services/scope';
import { mirrorRentalArtwork } from '../services/artworkMirror';

/**
 * Admin CRUD for ad_contracts.
 *
 * A contract is the *commercial* agreement between a client and a screen:
 * one client_id, one device_id, a term window, billing info, and an
 * auto-renew flag. It groups one or more rentals (the actual ad
 * creatives that ran/are running under the agreement).
 *
 * Multi-tenant scoping piggy-backs on the device — ad_contracts itself
 * has no organization_id column, but every contract belongs to exactly
 * one device, and the device carries the org. We JOIN devices into
 * every read so orgClause() can filter against `d.organization_id`.
 *
 * Mounted at /api/ad-contracts.
 */
const router = Router();

router.use(authRequired);

interface AdContractRow {
  id: string;
  client_id: number;
  device_id: string;
  contract_type: 'rental' | 'owner_perpetual';
  status: 'active' | 'expired' | 'cancelled';
  start_date: string;
  end_date: string | null;
  term_unit: 'day' | 'week' | 'month' | 'year' | null;
  term_count: number | null;
  amount_cents: number | null;
  currency: string;
  auto_renew: boolean;
  renewal_invoice_id: string | null;
  renewal_invoiced_at: string | null;
  billing_contact_email: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields (hydrated on read)
  device_name?: string;
  device_location?: string | null;
  device_organization_id?: string;
  rental_count?: number;
}

const COLS = `
  c.id, c.client_id, c.device_id, c.contract_type, c.status,
  c.start_date, c.end_date, c.term_unit, c.term_count,
  c.amount_cents, c.currency, c.auto_renew,
  c.renewal_invoice_id, c.renewal_invoiced_at,
  c.billing_contact_email, c.notes,
  c.created_at, c.updated_at
`;

// --- LIST ---

const listQuerySchema = z.object({
  deviceId: z.string().uuid().optional(),
  clientId: z.coerce.number().int().optional(),
  status: z.enum(['active', 'expired', 'cancelled']).optional(),
  contractType: z.enum(['rental', 'owner_perpetual']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

router.get('/', requireRole('super_admin', 'org_admin'), async (req, res) => {
  const q = listQuerySchema.parse(req.query);
  // Scope through devices.organization_id. Param order: [filters..., scope?, limit].
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (q.deviceId)               { where.push(`c.device_id = $${i++}`);    params.push(q.deviceId); }
  if (q.clientId !== undefined) { where.push(`c.client_id = $${i++}`);    params.push(q.clientId); }
  if (q.status)                 { where.push(`c.status = $${i++}`);       params.push(q.status); }
  if (q.contractType)           { where.push(`c.contract_type = $${i++}`); params.push(q.contractType); }
  const { clause: orgC, params: orgP } = orgClause(req, 'd.organization_id', i);
  params.push(...orgP);
  i += orgP.length;
  params.push(q.limit);
  const limitIdx = i;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')} ${orgC}` : (orgC ? `WHERE 1=1 ${orgC}` : '');
  const { rows } = await query<AdContractRow>(
    `SELECT ${COLS},
            d.name AS device_name, d.location AS device_location,
            d.organization_id AS device_organization_id,
            (SELECT COUNT(*)::int FROM rentals r WHERE r.contract_id = c.id) AS rental_count
       FROM ad_contracts c
       JOIN devices d ON d.id = c.device_id
       ${whereSql}
      ORDER BY c.created_at DESC
      LIMIT $${limitIdx}`,
    params,
  );
  res.json(rows);
});

// --- GET (detail) ---

router.get('/:id', requireRole('super_admin', 'org_admin'), async (req, res) => {
  const { clause, params } = orgClause(req, 'd.organization_id', 2);
  const { rows } = await query<AdContractRow>(
    `SELECT ${COLS},
            d.name AS device_name, d.location AS device_location,
            d.organization_id AS device_organization_id
       FROM ad_contracts c
       JOIN devices d ON d.id = c.device_id
      WHERE c.id = $1 ${clause}`,
    [req.params.id, ...params],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Also surface the rentals that ran under this contract.
  const { rows: rentals } = await query(
    `SELECT r.id, r.status, r.start_date, r.end_date, r.start_time, r.end_time,
            r.amount_cents, r.currency, r.advertiser_name, r.media_id,
            r.created_at, m.storage_url AS artwork_url, m.mime_type AS artwork_mime
       FROM rentals r
       LEFT JOIN media m ON m.id = r.media_id
      WHERE r.contract_id = $1
      ORDER BY r.created_at DESC`,
    [req.params.id],
  );
  res.json({ ...rows[0], rentals });
});

// --- CREATE ---

const createSchema = z.object({
  clientId: z.number().int(),
  deviceId: z.string().uuid(),
  contractType: z.enum(['rental', 'owner_perpetual']).default('rental'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expect YYYY-MM-DD').optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expect YYYY-MM-DD').optional(),
  termUnit: z.enum(['day', 'week', 'month', 'year']).optional(),
  termCount: z.number().int().positive().optional(),
  amountCents: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).default('CAD'),
  autoRenew: z.boolean().default(false),
  billingContactEmail: z.string().email().optional(),
  notes: z.string().max(2000).optional(),
  /** Optionally attribute an existing rental to this contract on creation. */
  attachRentalId: z.string().uuid().optional(),
}).refine(
  (d) => {
    if (d.contractType === 'owner_perpetual') {
      // Owner-perpetual cannot have end_date / amount / auto_renew set.
      return !d.endDate && d.amountCents === undefined && d.autoRenew === false;
    }
    return true;
  },
  { message: 'owner_perpetual contracts cannot have end_date, amount, or auto_renew set' },
);

router.post('/', requireRole('super_admin', 'org_admin'), async (req, res) => {
  const data = createSchema.parse(req.body);

  // Confirm the device is in the caller's scope before we'll link a contract to it.
  const { clause, params } = orgClause(req, 'organization_id', 2);
  const dev = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM devices WHERE id = $1 ${clause}`,
    [data.deviceId, ...params],
  );
  if (dev.rows.length === 0) {
    res.status(404).json({ error: 'device not found in your scope' });
    return;
  }

  const { rows } = await query<AdContractRow>(
    `INSERT INTO ad_contracts (
       client_id, device_id, contract_type, status,
       start_date, end_date, term_unit, term_count,
       amount_cents, currency, auto_renew,
       billing_contact_email, notes
     )
     VALUES (
       $1, $2, $3, 'active',
       COALESCE($4::date, CURRENT_DATE), $5::date, $6, $7,
       $8, $9, $10,
       $11, $12
     )
     RETURNING ${COLS.replace(/c\./g, '')}`,
    [
      data.clientId, data.deviceId, data.contractType,
      data.startDate ?? null, data.endDate ?? null,
      data.termUnit ?? null, data.termCount ?? null,
      data.amountCents ?? null, data.currency, data.autoRenew,
      data.billingContactEmail ?? null, data.notes ?? null,
    ],
  );
  const contract = rows[0];

  // If admin asked to attribute an existing ad in the same call, link it now.
  if (data.attachRentalId) {
    await query(
      `UPDATE rentals SET contract_id = $1 WHERE id = $2 AND device_id = $3`,
      [contract.id, data.attachRentalId, data.deviceId],
    );
    // Now that the rental has a client link (via the contract), kick off a
    // best-effort mirror of its current artwork into L:\<client>\LED Ads\.
    void mirrorRentalArtwork(data.attachRentalId);
  }

  res.status(201).json(contract);
});

// --- UPDATE ---

const updateSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  termUnit: z.enum(['day', 'week', 'month', 'year']).nullable().optional(),
  termCount: z.number().int().positive().nullable().optional(),
  amountCents: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  autoRenew: z.boolean().optional(),
  billingContactEmail: z.string().email().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'expired', 'cancelled']).optional(),
});

router.patch('/:id', requireRole('super_admin', 'org_admin'), async (req, res) => {
  const data = updateSchema.parse(req.body);

  // Confirm contract is in scope.
  const { clause, params } = orgClause(req, 'd.organization_id', 2);
  const ex = await query<{ contract_type: string }>(
    `SELECT c.contract_type FROM ad_contracts c
     JOIN devices d ON d.id = c.device_id
     WHERE c.id = $1 ${clause}`,
    [req.params.id, ...params],
  );
  if (ex.rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // Owner-perpetual contracts are read-only on the billing fields. The
  // table check constraint enforces this too, but reject early with a
  // clearer error so admins don't get a raw 500.
  if (ex.rows[0].contract_type === 'owner_perpetual') {
    const billingTouched =
      data.endDate !== undefined || data.amountCents !== undefined ||
      data.autoRenew !== undefined || data.termUnit !== undefined ||
      data.termCount !== undefined;
    if (billingTouched) {
      res.status(400).json({ error: 'owner_perpetual contracts cannot have billing/term fields edited' });
      return;
    }
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const map: Array<[keyof typeof data, string]> = [
    ['startDate',            'start_date = $%::date'],
    ['endDate',              'end_date = $%::date'],
    ['termUnit',             'term_unit = $%'],
    ['termCount',            'term_count = $%'],
    ['amountCents',          'amount_cents = $%'],
    ['currency',             'currency = $%'],
    ['autoRenew',            'auto_renew = $%'],
    ['billingContactEmail',  'billing_contact_email = $%'],
    ['notes',                'notes = $%'],
    ['status',               'status = $%'],
  ];
  for (const [key, tmpl] of map) {
    if (data[key] !== undefined) {
      sets.push(tmpl.replace('%', String(i++)));
      values.push(data[key]);
    }
  }
  if (sets.length === 0) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }
  sets.push(`updated_at = NOW()`);
  values.push(req.params.id);
  const { rows } = await query<AdContractRow>(
    `UPDATE ad_contracts SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${COLS.replace(/c\./g, '')}`,
    values,
  );
  res.json(rows[0]);
});

// --- DELETE (soft) ---

router.delete('/:id', requireRole('super_admin', 'org_admin'), async (req, res) => {
  const { clause, params } = orgClause(req, 'd.organization_id', 2);
  const { rows } = await query<{ id: string; contract_type: string }>(
    `SELECT c.id, c.contract_type FROM ad_contracts c
     JOIN devices d ON d.id = c.device_id
     WHERE c.id = $1 ${clause}`,
    [req.params.id, ...params],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Owner_perpetual rows shouldn't be cancellable via this endpoint —
  // they're auto-managed by the devices.owner_client_id trigger. Tell
  // the admin to clear ownership on the device instead.
  if (rows[0].contract_type === 'owner_perpetual') {
    res.status(400).json({
      error: 'owner_perpetual contracts are managed via device ownership — clear devices.owner_client_id instead',
    });
    return;
  }
  await query(
    `UPDATE ad_contracts SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
    [req.params.id],
  );
  res.status(204).end();
});

// --- Attach / detach rentals ---

const attachSchema = z.object({ rentalId: z.string().uuid() });

router.post('/:id/attach-rental', requireRole('super_admin', 'org_admin'), async (req, res) => {
  const { rentalId } = attachSchema.parse(req.body);
  // Confirm contract + rental are both in the caller's scope and on the same device.
  const { clause, params } = orgClause(req, 'd.organization_id', 2);
  const ctr = await query<{ device_id: string }>(
    `SELECT c.device_id FROM ad_contracts c
     JOIN devices d ON d.id = c.device_id
     WHERE c.id = $1 ${clause}`,
    [req.params.id, ...params],
  );
  if (ctr.rows.length === 0) {
    res.status(404).json({ error: 'contract not found' });
    return;
  }
  const rent = await query<{ device_id: string; contract_id: string | null }>(
    `SELECT device_id, contract_id FROM rentals WHERE id = $1`,
    [rentalId],
  );
  if (rent.rows.length === 0) {
    res.status(404).json({ error: 'rental not found' });
    return;
  }
  if (rent.rows[0].device_id !== ctr.rows[0].device_id) {
    res.status(400).json({ error: 'rental is on a different device than the contract' });
    return;
  }
  await query(`UPDATE rentals SET contract_id = $1, updated_at = NOW() WHERE id = $2`, [req.params.id, rentalId]);
  // Newly attributed rental — kick off the L:\ mirror best-effort.
  void mirrorRentalArtwork(rentalId);
  res.json({ ok: true });
});

router.post('/:id/detach-rental', requireRole('super_admin', 'org_admin'), async (req, res) => {
  const { rentalId } = attachSchema.parse(req.body);
  await query(`UPDATE rentals SET contract_id = NULL, updated_at = NOW() WHERE id = $1 AND contract_id = $2`, [rentalId, req.params.id]);
  res.status(204).end();
});

export default router;
