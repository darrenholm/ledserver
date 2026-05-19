import { NextFunction, Request, Response } from 'express';
import ipaddr from 'ipaddr.js';
import { config } from '../config';

type Range = [ipaddr.IPv4 | ipaddr.IPv6, number];

const ranges: Range[] = config.ipWhitelist.map((cidr) => {
  const parsed = ipaddr.parseCIDR(cidr);
  return parsed as Range;
});

function clientIp(req: Request): string | undefined {
  const fwd = req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? undefined;
}

export function ipWhitelist(req: Request, res: Response, next: NextFunction): void {
  if (ranges.length === 0) {
    next();
    return;
  }
  const raw = clientIp(req);
  if (!raw) {
    res.status(403).json({ error: 'no client ip' });
    return;
  }
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    const parsed = ipaddr.parse(raw);
    addr = parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
      ? (parsed as ipaddr.IPv6).toIPv4Address()
      : parsed;
  } catch {
    res.status(403).json({ error: 'invalid client ip' });
    return;
  }
  const allowed = ranges.some(([net, bits]) => {
    if (addr.kind() !== net.kind()) return false;
    return (addr as ipaddr.IPv4).match(net as ipaddr.IPv4, bits) || (addr as ipaddr.IPv6).match(net as ipaddr.IPv6, bits);
  });
  if (!allowed) {
    res.status(403).json({ error: 'ip not whitelisted' });
    return;
  }
  next();
}
