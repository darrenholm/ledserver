import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export type Role = 'super_admin' | 'org_admin' | 'org_operator' | 'org_viewer';

export interface AuthPayload {
  sub: string;              // user id
  username: string;
  role: Role;
  orgId: string | null;     // null for super_admin
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthPayload;
    /** Effective organization scope for the request — user's org, or super-admin override, or null = unscoped. */
    orgScope?: string | null;
  }
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn } as jwt.SignOptions);
}

export function authRequired(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  const token = header.slice('Bearer '.length);
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as AuthPayload;
    req.user = decoded;
    if (decoded.role === 'super_admin') {
      const override = (req.query.orgId as string | undefined) ?? req.header('x-org-id') ?? undefined;
      req.orgScope = override && override !== 'all' ? override : null;
    } else {
      req.orgScope = decoded.orgId;
    }
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}

/** Super-admin always passes; otherwise the user's role must be in `roles`. */
export function requireOrgRole(...roles: Role[]) {
  return requireRole('super_admin', ...roles);
}
