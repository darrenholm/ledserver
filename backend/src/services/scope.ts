import { Request } from 'express';
import { query } from '../db';

/**
 * Build a SQL WHERE fragment that scopes a query to a request's effective org.
 * Returns the appended clause and the param value to bind (if any).
 *
 *   const { clause, params } = orgClause(req, 'organization_id', 1);
 *   const sql = `SELECT * FROM devices WHERE 1=1 ${clause} ORDER BY created_at DESC`;
 *
 * - super_admin with no override (req.orgScope === null): no clause, no params.
 * - super_admin with override:                              ` AND organization_id = $1`, [orgId]
 * - any other user:                                          ` AND organization_id = $1`, [userOrgId]
 */
export function orgClause(req: Request, column: string, startIndex: number): { clause: string; params: string[] } {
  const scope = req.orgScope;
  if (scope === undefined || scope === null) return { clause: '', params: [] };
  return { clause: ` AND ${column} = $${startIndex}`, params: [scope] };
}

/**
 * The org id to use when CREATING a new row.
 * - Org users: their own org.
 * - Super admin with X-Org-Id / ?orgId override: that org.
 * - Super admin with no override AND exactly one organization in the
 *   system: auto-use it. Most LED installs are single-tenant (one
 *   "Holm Graphics" org), so a fresh super_admin shouldn't have to
 *   pick before they can upload media or register a device.
 * - Super admin with no override AND multiple orgs: throws 400 so the
 *   route can return a clear error and the user picks via the Orgs
 *   page or the X-Org-Id header.
 *
 * Async because the single-org auto-default needs to hit the DB. Routes
 * that previously called this synchronously need an `await`.
 */
export async function orgForInsert(req: Request): Promise<string> {
  if (!req.user) throw new Error('orgForInsert called without auth');
  if (req.user.role === 'super_admin') {
    if (req.orgScope) return req.orgScope;
    // Single-tenant fallback. LIMIT 2 so we can tell "exactly one" from
    // "more than one" with the minimum scan.
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM organizations LIMIT 2`,
    );
    if (rows.length === 1) return rows[0].id;
    const err = new Error(
      rows.length === 0
        ? 'no organizations exist; create one before adding resources'
        : 'super_admin must specify ?orgId= or X-Org-Id when creating (multiple organizations exist)',
    );
    (err as any).status = 400;
    throw err;
  }
  // Non-super-admin: their org is fixed.
  return req.user.orgId as string;
}
