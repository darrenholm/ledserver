import { config } from '../config';

export interface ChargeArgs {
  /** Opaque Intuit token obtained from /api/internal/tokenize-public. */
  token: string;
  /** Amount in dollars (not cents — matches shop-api's qb-payments contract). */
  amount: number;
  currency?: string;
  description?: string;
  /** Idempotency key. Reuse the rental id so retries don't double-charge. */
  requestId?: string;
}

export interface ChargeResult {
  ok: boolean;
  charge_id: string;
  status: string;
  amount: number;
  currency: string;
  card_brand?: string;
  card_last4?: string;
  auth_code?: string;
}

export class ShopApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
  }
}

function endpoint(path: string): string {
  if (!config.shopApi.baseUrl) {
    throw new ShopApiError(503, 'SHOP_API_BASE_URL not configured');
  }
  return `${config.shopApi.baseUrl.replace(/\/$/, '')}${path}`;
}

/**
 * Charge a previously-tokenized card via the shop-api bridge.
 * Throws ShopApiError on non-ok responses; the caller decides whether to
 * surface that as a user-facing error or retry.
 */
export async function chargeViaShopApi(args: ChargeArgs): Promise<ChargeResult> {
  if (!config.shopApi.bridgeSecret) {
    throw new ShopApiError(503, 'LED_SHOP_BRIDGE_SECRET not configured');
  }
  const res = await fetch(endpoint('/api/internal/charge'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': config.shopApi.bridgeSecret,
    },
    body: JSON.stringify({
      token: args.token,
      amount: args.amount,
      currency: args.currency ?? 'CAD',
      description: args.description,
      requestId: args.requestId,
    }),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `shop-api charge failed (${res.status})`;
    throw new ShopApiError(res.status, msg, body);
  }
  return body as ChargeResult;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
