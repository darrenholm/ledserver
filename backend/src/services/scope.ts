import { Request } from 'express';

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
 * - Super admin: must pick an org via ?orgId / X-Org-Id; otherwise this throws (the route should 400 in that case).
 */
export function orgForInsert(req: Request): string {
  if (!req.user) throw new Error('orgForInsert called without auth');
  if (req.user.role === 'super_admin') {
    if (!req.orgScope) {
      const err = new Error('super_admin must specify ?orgId= or X-Org-Id when creating');
      (err as any).status = 400;
      throw err;
    }
    return req.orgScope;
  }
  // Non-super-admin: their org is fixed.
  return req.user.orgId as string;
}
