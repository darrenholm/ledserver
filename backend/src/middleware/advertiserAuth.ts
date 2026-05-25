/**
 * Verify a customer JWT minted by shop-api (holmgraphics.ca/login) and
 * attach the advertiser identity to the request. Used by the self-serve
 * ad portal at /advertise/my-ads to scope operations to the logged-in
 * client.
 *
 * Separate from the staff `authRequired` middleware in ./auth.ts — staff
 * tokens carry no `realm` field and don't satisfy this check; customer
 * tokens carry realm='customer' and don't satisfy staff endpoints. The
 * isolation is enforced by checking the realm explicitly here.
 */
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AdvertiserPayload {
  /** clients.id on shop-api. Numeric. */
  id: number;
  email: string;
  name: string;
  company: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    advertiser?: AdvertiserPayload;
  }
}

interface CustomerJwtPayload {
  realm?: string;
  id?: number;
  email?: string;
  name?: string;
  company?: string | null;
}

/**
 * Hard requirement — 401 if no valid customer JWT.
 */
export function requireAdvertiser(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  const token = header.slice('Bearer '.length);
  try {
    const decoded = jwt.verify(token, config.customerJwt.secret) as CustomerJwtPayload;
    if (decoded.realm !== 'customer') {
      res.status(401).json({ error: 'not a customer token' });
      return;
    }
    if (typeof decoded.id !== 'number' || !decoded.email) {
      res.status(401).json({ error: 'malformed customer token' });
      return;
    }
    req.advertiser = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name || decoded.email,
      company: decoded.company ?? null,
    };
    next();
  } catch {
    res.status(401).json({ error: 'invalid customer token' });
  }
}

/**
 * Soft — if a valid customer JWT is present, attach it; otherwise continue
 * unauthenticated. Used by endpoints that still accept the legacy "rental
 * id is the secret" model but want to grant extra privileges to a logged-in
 * advertiser (e.g. instant publish via trust_self_serve_ads).
 */
export function optionalAdvertiser(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return next();
  const token = header.slice('Bearer '.length);
  try {
    const decoded = jwt.verify(token, config.customerJwt.secret) as CustomerJwtPayload;
    if (decoded.realm === 'customer' && typeof decoded.id === 'number' && decoded.email) {
      req.advertiser = {
        id: decoded.id,
        email: decoded.email,
        name: decoded.name || decoded.email,
        company: decoded.company ?? null,
      };
    }
  } catch {
    // Bad token = treat as unauthenticated; don't 401 because soft auth.
  }
  next();
}
