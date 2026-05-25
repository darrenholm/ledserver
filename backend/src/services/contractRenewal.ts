/**
 * Ad-contract renewal cron.
 *
 * Scans `ad_contracts` for rows where:
 *   - auto_renew = TRUE
 *   - status = 'active'
 *   - end_date is within RENEWAL_LEAD_DAYS of today (default 30)
 *   - renewal_invoiced_at IS NULL (never been billed for this term)
 *
 * For each match, calls shop-api `/api/internal/create-rental-invoice`
 * to mint a QBO Invoice (auto-emailed by QBO). Stamps
 * `renewal_invoice_id` + `renewal_invoiced_at` immediately so we never
 * double-bill, even if a later step fails.
 *
 * DORMANT by default. Gated on `config.renewal.autoInvoiceEnabled`,
 * which reads `RENEWAL_AUTO_INVOICE` env var. While off, the cron
 * still TICKS — but it just logs a "would-invoice" preview without
 * calling shop-api or touching the DB. That lets you see, in
 * production, exactly which contracts would have been billed before
 * flipping the switch.
 */
import { query } from '../db';
import { config } from '../config';
import {
  createRentalInvoiceViaShopApi,
  ShopApiError,
} from './shopApiClient';
import { writeLog } from './logs';

const TICK_INTERVAL_MS = 60 * 60 * 1000; // hourly — same cadence as rentalExpiry

interface DueContractRow {
  id: string;
  client_id: number;
  device_id: string;
  start_date: string;
  end_date: string;
  amount_cents: number | null;
  currency: string;
  billing_contact_email: string | null;
  device_name: string;
}

export async function contractRenewalTick(): Promise<void> {
  // Pull every active rental contract whose term ends within the lead
  // window and hasn't been invoiced yet. Owner-perpetual contracts are
  // excluded by the auto_renew=true filter (their CHECK constraint
  // forbids auto_renew on owner_perpetual rows).
  const leadDays = config.renewal.leadDays;
  const { rows } = await query<DueContractRow>(
    `SELECT c.id, c.client_id, c.device_id, c.start_date, c.end_date,
            c.amount_cents, c.currency, c.billing_contact_email,
            d.name AS device_name
       FROM ad_contracts c
       JOIN devices d ON d.id = c.device_id
      WHERE c.auto_renew = TRUE
        AND c.status = 'active'
        AND c.renewal_invoiced_at IS NULL
        AND c.end_date IS NOT NULL
        AND c.end_date <= (CURRENT_DATE + ($1 || ' days')::interval)::date
        AND c.end_date >= CURRENT_DATE`,
    [String(leadDays)],
  );

  if (rows.length === 0) return;

  if (!config.renewal.autoInvoiceEnabled) {
    // Dormant mode: log what we *would* do, don't touch anything.
    // eslint-disable-next-line no-console
    console.log(
      `[contractRenewal] DRY RUN — ${rows.length} contract(s) due for renewal but RENEWAL_AUTO_INVOICE is off. ` +
        `Would invoice: ${rows.map((r) => `${r.id}/${r.device_name}/$${(r.amount_cents ?? 0) / 100}`).join(', ')}`,
    );
    return;
  }

  let succeeded = 0;
  let failed = 0;
  for (const c of rows) {
    if (!c.amount_cents || c.amount_cents <= 0) {
      // No price on the contract — can't invoice. Stamp the row anyway so
      // we don't loop on it; admin can clear the stamp if they intended
      // to set an amount before the term ended.
      // eslint-disable-next-line no-console
      console.warn(`[contractRenewal] skipping contract ${c.id} — no amount_cents set`);
      continue;
    }
    const contractRef = `c-${c.id.replace(/-/g, '').slice(0, 8)}`;
    const dueDate = c.end_date; // existing term end = invoice due date
    try {
      const invoice = await createRentalInvoiceViaShopApi({
        clientId:        c.client_id,
        contractRef,
        lineDescription:
          `LED ad rental renewal — ${c.device_name} (term ending ${c.end_date})`,
        amountCents:     c.amount_cents,
        dueDate,
        billingEmail:    c.billing_contact_email ?? undefined,
      });
      await query(
        `UPDATE ad_contracts
            SET renewal_invoice_id  = $1,
                renewal_invoiced_at = NOW(),
                updated_at = NOW()
          WHERE id = $2`,
        [invoice.id, c.id],
      );
      succeeded++;
    } catch (err) {
      failed++;
      const msg = err instanceof ShopApiError ? `${err.status} ${err.message}` : (err as Error).message;
      // eslint-disable-next-line no-console
      console.error(`[contractRenewal] invoice mint failed for contract ${c.id}: ${msg}`);
      // Don't stamp on failure — we want to retry on the next tick.
    }
  }

  if (succeeded > 0 || failed > 0) {
    await writeLog(
      failed > 0 ? 'warn' : 'info',
      'system',
      `contract renewal cron: invoiced ${succeeded}, failed ${failed}`,
      null,
      { succeeded, failed, leadDays },
    );
  }
}

let timer: NodeJS.Timeout | null = null;

export function startContractRenewalCron(): void {
  void contractRenewalTick().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('contractRenewal initial tick failed:', e);
  });
  timer = setInterval(() => {
    void contractRenewalTick().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('contractRenewal tick failed:', e);
    });
  }, TICK_INTERVAL_MS);
}

export function stopContractRenewalCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
