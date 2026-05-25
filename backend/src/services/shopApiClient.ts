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

// ─── Job-board bridge: client + project upsert ───────────────────────────────

interface UpsertClientArgs {
  email: string;
  name?: string;
  business?: string;
  phone?: string;
}

interface UpsertClientResult {
  id: number;
  created: boolean;
}

export async function upsertClientViaShopApi(args: UpsertClientArgs): Promise<UpsertClientResult> {
  if (!config.shopApi.bridgeSecret) {
    throw new ShopApiError(503, 'LED_SHOP_BRIDGE_SECRET not configured');
  }
  const res = await fetch(endpoint('/api/internal/upsert-client'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': config.shopApi.bridgeSecret,
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `shop-api upsert-client failed (${res.status})`;
    throw new ShopApiError(res.status, msg, body);
  }
  return body as UpsertClientResult;
}

interface CreateProjectArgs {
  clientId: number;
  description: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  statusId?: number;
  projectTypeId?: number;
  dueDate?: string;       // YYYY-MM-DD
  poNumber?: string;
}

interface CreateProjectResult {
  id: number;
}

export async function createProjectViaShopApi(args: CreateProjectArgs): Promise<CreateProjectResult> {
  if (!config.shopApi.bridgeSecret) {
    throw new ShopApiError(503, 'LED_SHOP_BRIDGE_SECRET not configured');
  }
  const res = await fetch(endpoint('/api/internal/create-project'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': config.shopApi.bridgeSecret,
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `shop-api create-project failed (${res.status})`;
    throw new ShopApiError(res.status, msg, body);
  }
  return body as CreateProjectResult;
}

// ─── QBO Sales Receipt ───────────────────────────────────────────────────────

interface CreateSalesReceiptArgs {
  clientId: number;
  lineDescription: string;
  amountCents: number;
  currency?: string;
  paymentRef?: string;
  chargeDate?: string;    // ISO date or datetime
}

interface CreateSalesReceiptResult {
  id: string;             // QBO returns string IDs
}

export async function createSalesReceiptViaShopApi(
  args: CreateSalesReceiptArgs,
): Promise<CreateSalesReceiptResult> {
  if (!config.shopApi.bridgeSecret) {
    throw new ShopApiError(503, 'LED_SHOP_BRIDGE_SECRET not configured');
  }
  const res = await fetch(endpoint('/api/internal/create-sales-receipt'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': config.shopApi.bridgeSecret,
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `shop-api create-sales-receipt failed (${res.status})`;
    throw new ShopApiError(res.status, msg, body);
  }
  return body as CreateSalesReceiptResult;
}

// ─── Client trust lookup (for self-serve ad swaps) ──────────────────────────

export interface ClientLookupResult {
  id: number;
  email: string;
  company: string | null;
  name: string;
  trust_self_serve_ads: boolean;
}

export async function lookupClientViaShopApi(clientId: number): Promise<ClientLookupResult> {
  if (!config.shopApi.bridgeSecret) {
    throw new ShopApiError(503, 'LED_SHOP_BRIDGE_SECRET not configured');
  }
  const res = await fetch(endpoint('/api/internal/lookup-client'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': config.shopApi.bridgeSecret,
    },
    body: JSON.stringify({ clientId }),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `shop-api lookup-client failed (${res.status})`;
    throw new ShopApiError(res.status, msg, body);
  }
  return body as ClientLookupResult;
}

// ─── Client search (for the LED admin's "Add ad contract" modal) ────────────

export interface ClientSearchHit {
  id: number;
  email: string | null;
  company: string | null;
  name: string;
}

export async function searchClientsViaShopApi(q: string, limit = 20): Promise<ClientSearchHit[]> {
  if (!config.shopApi.bridgeSecret) {
    throw new ShopApiError(503, 'LED_SHOP_BRIDGE_SECRET not configured');
  }
  const res = await fetch(endpoint('/api/internal/search-clients'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': config.shopApi.bridgeSecret,
    },
    body: JSON.stringify({ q, limit }),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `shop-api search-clients failed (${res.status})`;
    throw new ShopApiError(res.status, msg, body);
  }
  return ((body as { clients?: ClientSearchHit[] }).clients) ?? [];
}

// ─── L:\ artwork mirror ──────────────────────────────────────────────────────

interface MirrorArtworkArgs {
  sourceUrl: string;
  clientId: number;
  contractRef: string;
  filename: string;
  mimeType?: string;
}

interface MirrorArtworkResult {
  ok: true;
  clientFolder: string;
  contractFolder: string;
  path: string;
  size: number;
}

/**
 * Best-effort: pushes a copy of an LED ad creative into the client's
 * L:\<client>\LED Ads\<contractRef>\ folder via shop-api → files-bridge.
 * Caller should catch ShopApiError and continue — the rental still works
 * without the mirror (LED app serves VNNOX from its own volume).
 */
export async function mirrorAdArtworkViaShopApi(args: MirrorArtworkArgs): Promise<MirrorArtworkResult> {
  if (!config.shopApi.bridgeSecret) {
    throw new ShopApiError(503, 'LED_SHOP_BRIDGE_SECRET not configured');
  }
  const res = await fetch(endpoint('/api/internal/mirror-ad-artwork'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': config.shopApi.bridgeSecret,
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `shop-api mirror-ad-artwork failed (${res.status})`;
    throw new ShopApiError(res.status, msg, body);
  }
  return body as MirrorArtworkResult;
}

// ─── QBO Invoice (renewals) ──────────────────────────────────────────────────

interface CreateRentalInvoiceArgs {
  clientId: number;
  contractRef: string;
  lineDescription: string;
  amountCents: number;
  dueDate?: string;        // YYYY-MM-DD
  billingEmail?: string;
}

interface CreateRentalInvoiceResult {
  id: string;              // QBO Invoice id
  billEmail: string | null;
}

export async function createRentalInvoiceViaShopApi(
  args: CreateRentalInvoiceArgs,
): Promise<CreateRentalInvoiceResult> {
  if (!config.shopApi.bridgeSecret) {
    throw new ShopApiError(503, 'LED_SHOP_BRIDGE_SECRET not configured');
  }
  const res = await fetch(endpoint('/api/internal/create-rental-invoice'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': config.shopApi.bridgeSecret,
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `shop-api create-rental-invoice failed (${res.status})`;
    throw new ShopApiError(res.status, msg, body);
  }
  return body as CreateRentalInvoiceResult;
}

export async function setClientTrustViaShopApi(clientId: number, trust: boolean): Promise<{ id: number; trust_self_serve_ads: boolean }> {
  if (!config.shopApi.bridgeSecret) {
    throw new ShopApiError(503, 'LED_SHOP_BRIDGE_SECRET not configured');
  }
  const res = await fetch(endpoint('/api/internal/set-client-trust'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': config.shopApi.bridgeSecret,
    },
    body: JSON.stringify({ clientId, trust }),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `shop-api set-client-trust failed (${res.status})`;
    throw new ShopApiError(res.status, msg, body);
  }
  return body as { id: number; trust_self_serve_ads: boolean };
}
