import crypto from 'crypto';
import { Agent } from 'undici';
import { config } from '../config';

export interface VnnoxAuthHeaders {
  AppKey: string;
  Nonce: string;
  CurTime: string;
  CheckSum: string;
}

/**
 * NovaCloud Open Platform auth headers.
 * CheckSum = SHA256(AppSecret + Nonce + CurTime), hex-encoded.
 * Nonce is a fresh random string each call. CurTime is Unix seconds.
 */
export function signRequest(): VnnoxAuthHeaders {
  const { appKey, appSecret } = config.vnnox;
  if (!appKey || !appSecret) {
    throw new Error('VNNOX_APP_KEY and VNNOX_APP_SECRET must be set to call VNNOX APIs');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const curTime = String(Math.floor(Date.now() / 1000));
  const checksum = crypto
    .createHash('sha256')
    .update(appSecret + nonce + curTime)
    .digest('hex');
  return {
    AppKey: appKey,
    Nonce: nonce,
    CurTime: curTime,
    CheckSum: checksum,
  };
}

export function vnnoxBaseUrl(): string {
  return `https://open-${config.vnnox.region}.vnnox.com`;
}

/**
 * Custom dispatcher for VNNOX calls with keepalive effectively disabled.
 *
 * Why: NovaStar's edge (Cloudflare in front of their NovaCloud platform)
 * silently kills idle keepalive sockets. Undici's default global Dispatcher
 * pools connections across requests, so the NEXT request reuses a socket
 * the server has already half-closed — manifesting as `Error: terminated`
 * mid-response. We saw this fire repeatedly during artwork swaps even with
 * exponential-backoff retries, because the pool keeps handing back the
 * same dying socket.
 *
 * Setting keepAliveTimeout to 1ms forces undici to close the socket
 * immediately after the response completes, so every VNNOX request gets a
 * fresh TCP connection. Cost is a TLS handshake per call (~50-100ms on
 * Railway → us-east) which is fine for our publish volume (a few per day).
 *
 * Shared singleton so we're not constructing a new Agent per call.
 */
export const vnnoxDispatcher = new Agent({
  keepAliveTimeout: 1,
  keepAliveMaxTimeout: 1,
  // Cap connections per host. We never make concurrent VNNOX calls today,
  // but keeping this small means if we ever do, we won't accidentally
  // hammer their edge.
  connections: 4,
});

/**
 * Drop-in replacement for fetch() that uses the VNNOX-specific dispatcher
 * and adds the standard auth headers. Callers can still pass any additional
 * fetch options.
 *
 * Usage:
 *   const res = await vnnoxFetch(`${vnnoxBaseUrl()}/v2/...`, {
 *     method: 'POST',
 *     body: JSON.stringify(payload),
 *   });
 */
export async function vnnoxFetch(
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    // Belt: tell the server we won't reuse the connection either, so it
    // doesn't bother sending Keep-Alive headers we'd ignore.
    Connection: 'close',
    ...signRequest(),
    ...(init.headers ?? {}),
  };
  // Node-specific `dispatcher` option lives in undici-types, but the global
  // fetch's RequestInit is the lib.dom one and doesn't know about it. Cast
  // through `unknown` to bridge the two without `any`.
  return fetch(
    url,
    { ...init, headers, dispatcher: vnnoxDispatcher } as unknown as RequestInit,
  );
}
