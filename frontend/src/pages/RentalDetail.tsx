import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { rentals as rentalsApi } from '../api/endpoints';
import type { AdminRental } from '../types';

function fmtMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
}

/** "14:30" or "14:30:00" → "2:30 PM" */
function fmt12(t: string | null | undefined): string {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  const am = h < 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = m.toString().padStart(2, '0');
  return `${h12}:${mm} ${am ? 'AM' : 'PM'}`;
}

function describeDaypart(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return '—';
  const s = start.slice(0, 5);
  const e = end.slice(0, 5);
  if (s === '00:00' && (e === '23:59' || e === '23:58')) return 'All day';
  return `Daily ${fmt12(start)} – ${fmt12(end)}`;
}

export default function RentalDetail() {
  const { id } = useParams<{ id: string }>();
  const [rental, setRental] = useState<AdminRental | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [paymentRef, setPaymentRef] = useState('');
  // Cached from shop-api: whether this rental's client is allowed to swap
  // ads without re-review. Loaded lazily after the rental itself; nulled
  // out for legacy rentals with no project_client_id link yet.
  const [trust, setTrust] = useState<boolean | null>(null);
  const [trustLoaded, setTrustLoaded] = useState(false);

  const refresh = () => {
    if (!id) return;
    rentalsApi.get(id).then(setRental).catch((e) => setErr((e as Error).message));
    rentalsApi.getClientTrust(id)
      .then((t) => { setTrust(t.trust); setTrustLoaded(true); })
      .catch(() => setTrustLoaded(true));
  };

  useEffect(() => {
    refresh();
  }, [id]);

  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!rental) {
    return (
      <div>
        <Link to="/rentals" className="muted">← All rentals</Link>
        {err ? <div className="error-banner">{err}</div> : <div className="muted">Loading…</div>}
      </div>
    );
  }

  const canApprove = ['pending_review', 'approved'].includes(rental.status);
  const canReject = ['pending_review', 'approved'].includes(rental.status);
  const canMarkPaid = rental.status === 'pending_payment';
  const canRepublish = ['approved', 'active'].includes(rental.status);

  return (
    <div className="stack">
      <Link to="/rentals" className="muted" style={{ fontSize: 13 }}>← All rentals</Link>
      <h1 style={{ margin: 0 }}>{rental.advertiser_name} — {rental.device_name}</h1>

      {err && <div className="error-banner">{err}</div>}

      <div className="row" style={{ gap: 16, alignItems: 'stretch' }}>
        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Booking</h3>
          <div className="stack">
            <div><span className="muted">Status:</span> {rental.status.replace('_', ' ')}</div>
            <div><span className="muted">Window:</span> {rental.start_date && rental.end_date ? `${rental.start_date} → ${rental.end_date}` : 'scheduled on approval'}</div>
            <div><span className="muted">Daypart:</span> {describeDaypart(rental.start_time, rental.end_time)}</div>
            <div><span className="muted">Duration:</span> {rental.duration_count} {rental.duration_unit}{rental.duration_count > 1 ? 's' : ''}</div>
            <div><span className="muted">Total:</span> {fmtMoney(rental.amount_cents, rental.currency)}</div>
            <div><span className="muted">Paid:</span> {rental.paid_at ? `${new Date(rental.paid_at).toLocaleDateString()} (${rental.payment_provider}: ${rental.payment_reference})` : '—'}</div>
            <div><span className="muted">Submitted:</span> {new Date(rental.created_at).toLocaleString()}</div>
          </div>
        </div>

        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Advertiser</h3>
          <div className="stack">
            <div><span className="muted">Name:</span> {rental.advertiser_name}</div>
            <div><span className="muted">Business:</span> {rental.advertiser_business ?? '—'}</div>
            <div><span className="muted">Email:</span> <a href={`mailto:${rental.advertiser_email}`}>{rental.advertiser_email}</a></div>
            <div><span className="muted">Phone:</span> {rental.advertiser_phone ?? '—'}</div>
            {rental.advertiser_notes && (
              <div>
                <div className="muted">Notes:</div>
                <div style={{ fontSize: 14 }}>{rental.advertiser_notes}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {canRepublish && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>On-screen status</h3>
          <div className="stack">
            {rental.published_at ? (
              <div>
                <span className="muted">Published to VNNOX:</span>{' '}
                {new Date(rental.published_at).toLocaleString()}
                {rental.vnnox_program_id && (
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                    (program {rental.vnnox_program_id})
                  </span>
                )}
              </div>
            ) : (
              <div className="muted">Not yet published to the device.</div>
            )}
            {rental.publish_error && (
              <div style={{ padding: 8, background: 'rgba(227, 93, 93, 0.12)', borderRadius: 6, fontSize: 13 }}>
                <strong>Last publish error:</strong> {rental.publish_error}
              </div>
            )}
            <div className="row" style={{ gap: 8 }}>
              <button
                disabled={busy}
                onClick={() => action(() => rentalsApi.republish(rental.id))}
              >
                {rental.published_at ? 'Republish to device' : 'Publish to device now'}
              </button>
              <div className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
                Pushes (or refreshes) the VNNOX insertion program with the current run window and daypart.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Self-serve trust: hidden until the rental is paid + linked to a client. */}
      {trustLoaded && trust !== null && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Self-serve trust</h3>
          <div className="stack">
            <div className="muted" style={{ fontSize: 13 }}>
              When ON, this client can change their ad from the /advertise/my-ads
              portal and it goes live immediately. When OFF, every swap moves the
              rental back to pending review and pauses the on-screen ad until you
              approve the new art.
            </div>
            <label className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={!!trust}
                disabled={busy}
                onChange={(e) => action(async () => {
                  const next = e.target.checked;
                  const result = await rentalsApi.setClientTrust(rental.id, next);
                  setTrust(result.trust);
                })}
              />
              <span><strong>{trust ? 'Trusted' : 'Re-review required'}</strong> — flip for this client account</span>
            </label>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Artwork</h3>
        {rental.artwork_url ? (
          <>
            <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
              {rental.device_width_px && rental.device_height_px
                ? `Previewed at the display's aspect ratio (${rental.device_width_px} × ${rental.device_height_px} px). `
                : 'Display dimensions not on file — previewing at 16:9. '}
              Customer chose: <strong>{rental.fit_mode === 'cover' ? 'Stretch to fill' : 'Fit as-is (letterbox)'}</strong>
            </div>
            <div
              style={{
                width: '100%',
                background: '#000',
                border: '3px solid #222',
                borderRadius: 8,
                overflow: 'hidden',
                aspectRatio:
                  rental.device_width_px && rental.device_height_px
                    ? `${rental.device_width_px} / ${rental.device_height_px}`
                    : '16 / 9',
              }}
            >
              {rental.artwork_mime?.startsWith('video/') ? (
                <video
                  src={rental.artwork_url}
                  style={{ display: 'block', width: '100%', height: '100%', objectFit: rental.fit_mode === 'cover' ? 'cover' : 'contain' }}
                  muted
                  loop
                  autoPlay
                  playsInline
                />
              ) : (
                <img
                  src={rental.artwork_url}
                  alt="artwork"
                  style={{ display: 'block', width: '100%', height: '100%', objectFit: rental.fit_mode === 'cover' ? 'cover' : 'contain' }}
                />
              )}
            </div>
            {rental.artwork_warnings && rental.artwork_warnings.length > 0 && (
              <div style={{ marginTop: 12, padding: 12, background: 'rgba(230, 181, 74, 0.1)', borderRadius: 6, fontSize: 13 }}>
                <strong style={{ color: 'var(--yellow)' }}>Warnings:</strong>
                <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                  {rental.artwork_warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div className="muted">Advertiser hasn't uploaded artwork yet.</div>
        )}
      </div>

      {(canApprove || canReject || canMarkPaid) && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Actions</h3>

          {canMarkPaid && (
            <div className="stack" style={{ marginBottom: 16 }}>
              <label>Mark as paid — enter QB Payments reference / invoice number</label>
              <div className="row" style={{ gap: 8 }}>
                <input
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                  placeholder="QB invoice #12345"
                  style={{ flex: 1 }}
                />
                <button
                  disabled={busy || !paymentRef}
                  onClick={() => action(() => rentalsApi.markPaid(rental.id, paymentRef))}
                >
                  Mark paid
                </button>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                Marking as paid moves the booking into the review queue and emails you the artwork preview with approve/reject buttons.
              </div>
            </div>
          )}

          {(canApprove || canReject) && (
            <div className="stack">
              {canApprove && (
                <div className="row" style={{ gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label>Run start date</label>
                    <input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      min={new Date().toISOString().slice(0, 10)}
                    />
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      {(() => {
                        const days = rental.duration_count * (rental.duration_unit === 'day' ? 1 : rental.duration_unit === 'week' ? 7 : 30);
                        const end = new Date(startDate + 'T00:00:00Z');
                        end.setUTCDate(end.getUTCDate() + days - 1);
                        return `Ad will run ${days} day${days === 1 ? '' : 's'}, ending ${end.toISOString().slice(0, 10)}.`;
                      })()}
                    </div>
                  </div>
                </div>
              )}
              <div>
                <label>Review notes (optional, included in the email)</label>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </div>
              <div className="row" style={{ gap: 8 }}>
                {canApprove && (
                  <button
                    disabled={busy}
                    onClick={() => action(() => rentalsApi.approve(rental.id, { notes: notes || undefined, startDate }))}
                    style={{ background: 'var(--green)' }}
                  >
                    Approve &amp; notify advertiser
                  </button>
                )}
                {canReject && (
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => action(() => rentalsApi.reject(rental.id, notes || undefined))}
                  >
                    Reject
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
