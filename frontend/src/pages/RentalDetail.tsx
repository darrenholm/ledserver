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

  const refresh = () => {
    if (!id) return;
    rentalsApi.get(id).then(setRental).catch((e) => setErr((e as Error).message));
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

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Artwork</h3>
        {rental.artwork_url ? (
          <>
            {rental.artwork_mime?.startsWith('video/') ? (
              <video src={rental.artwork_url} controls style={{ maxWidth: '100%', borderRadius: 4 }} />
            ) : (
              <img src={rental.artwork_url} alt="artwork" style={{ maxWidth: '100%', borderRadius: 4, border: '1px solid var(--border)' }} />
            )}
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
