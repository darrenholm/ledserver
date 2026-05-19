import crypto from 'crypto';
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
