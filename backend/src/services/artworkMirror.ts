import { query } from '../db';
import { mirrorAdArtworkViaShopApi, ShopApiError } from './shopApiClient';

/**
 * Best-effort: copies a rental's current artwork into the client's L:\
 * folder via shop-api → files-bridge. Pure fire-and-forget — never throws.
 *
 * Lookup chain for the client id:
 *   1. ad_contracts.client_id (if rental.contract_id is set)
 *   2. rentals.project_client_id (legacy self-serve flow's link)
 *
 * If neither yields a client id, or the rental has no media, we log and
 * skip. Same for shop-api / files-bridge being offline — the rental still
 * works (VNNOX pulls from the LED app's own volume); the L:\ mirror is
 * a staff-convenience only.
 *
 * The contractRef is the first 8 chars of the contract UUID (or
 * 'rental-<8>' if the rental has no contract). Short, stable, filename-
 * safe. Lives in the folder name so staff browsing L:\ can correlate the
 * folder back to a contract in the LED admin.
 */
export async function mirrorRentalArtwork(rentalId: string): Promise<void> {
  try {
    const { rows } = await query<{
      contract_id: string | null;
      contract_client_id: number | null;
      project_client_id: number | null;
      media_id: string | null;
      storage_url: string | null;
      mime_type: string | null;
      original_name: string | null;
    }>(
      `SELECT r.contract_id,
              c.client_id    AS contract_client_id,
              r.project_client_id,
              r.media_id,
              m.storage_url,
              m.mime_type,
              m.original_name
         FROM rentals r
         LEFT JOIN ad_contracts c ON c.id = r.contract_id
         LEFT JOIN media m         ON m.id = r.media_id
        WHERE r.id = $1`,
      [rentalId],
    );
    if (rows.length === 0) {
      console.warn('[artworkMirror] rental not found:', rentalId);
      return;
    }
    const r = rows[0];
    if (!r.media_id || !r.storage_url) {
      // No artwork to mirror (yet) — common for fresh bookings awaiting upload.
      return;
    }
    const clientId = r.contract_client_id ?? r.project_client_id;
    if (!clientId) {
      // No client link — likely a self-serve booking that hasn't been
      // attributed yet. Silent skip; admin can attribute later and the
      // next artwork swap (or a manual mirror call) will catch it.
      return;
    }

    const contractRef = r.contract_id
      ? `c-${r.contract_id.replace(/-/g, '').slice(0, 8)}`
      : `rental-${rentalId.replace(/-/g, '').slice(0, 8)}`;

    // Filename: use the user's original filename if available, else fall
    // back to the rental id with an extension guessed from mime. Files-
    // bridge will sanitize and overwrite if a duplicate lands.
    const safeFilename =
      (r.original_name && r.original_name.trim()) ||
      `rental-${rentalId.slice(0, 8)}${mimeExt(r.mime_type)}`;

    await mirrorAdArtworkViaShopApi({
      sourceUrl:   r.storage_url,
      clientId,
      contractRef,
      filename:    safeFilename,
      mimeType:    r.mime_type ?? undefined,
    });
  } catch (err) {
    // Swallow + log. Mirror failures must never cascade up.
    if (err instanceof ShopApiError) {
      // 503 = shop-api not reachable / not configured. Loud only in dev.
      console.warn(`[artworkMirror] shop-api ${err.status}: ${err.message} (rentalId=${rentalId})`);
    } else {
      console.error(`[artworkMirror] failed for rental ${rentalId}:`, err);
    }
  }
}

function mimeExt(mime: string | null): string {
  if (!mime) return '';
  if (mime === 'image/png')  return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif')  return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'video/mp4')  return '.mp4';
  if (mime === 'video/webm') return '.webm';
  return '';
}
