import { ChangeEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { publicRentals } from '../api/endpoints';
import type { PublicRentalStatus } from '../types';

function fmtMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
}

const STATUS_COPY: Record<string, { label: string; tone: 'info' | 'good' | 'bad' }> = {
  pending_payment: { label: 'Waiting for payment', tone: 'info' },
  pending_review: { label: 'Pending review by Holm Graphics', tone: 'info' },
  approved: { label: 'Approved — scheduled to run', tone: 'good' },
  active: { label: 'Running on display', tone: 'good' },
  expired: { label: 'Expired (run completed)', tone: 'info' },
  rejected: { label: 'Not approved', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
};

export default function RentOrder() {
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<PublicRentalStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const refresh = () => {
    if (!id) return;
    publicRentals
      .status(id)
      .then((o) => {
        setOrder(o);
        setWarnings(o.artwork_warnings ?? []);
      })
      .catch((e) => setErr((e as Error).message));
  };

  useEffect(() => {
    refresh();
  }, [id]);

  const onUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !id) return;
    setUploading(true);
    setErr(null);
    try {
      const res = await publicRentals.uploadArtwork(id, file);
      setWarnings(res.warnings);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  if (!order) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px' }}>
        <Link to="/rent" className="muted">← All displays</Link>
        {err ? <div className="error-banner">{err}</div> : <div className="muted">Loading…</div>}
      </div>
    );
  }

  const tone = STATUS_COPY[order.status] ?? { label: order.status, tone: 'info' as const };
  const allowUpload = ['pending_payment', 'pending_review'].includes(order.status);

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px' }}>
      <Link to="/rent" className="muted" style={{ fontSize: 13 }}>← All displays</Link>
      <h1 style={{ margin: '8px 0 0' }}>Your ad on {order.device_name}</h1>
      <div className="muted">{order.start_date} → {order.end_date}</div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row between">
          <div>
            <div className="muted" style={{ fontSize: 13 }}>Status</div>
            <div style={{ fontWeight: 500, color: tone.tone === 'good' ? 'var(--green)' : tone.tone === 'bad' ? 'var(--red)' : undefined }}>
              {tone.label}
            </div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 13 }}>Total</div>
            <div style={{ fontWeight: 500 }}>{fmtMoney(order.amount_cents, order.currency)}</div>
          </div>
        </div>
        {order.paid_at && (
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            Paid {new Date(order.paid_at).toLocaleDateString()}
          </div>
        )}
        {order.review_notes && order.status === 'rejected' && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--surface-2)', borderRadius: 6, fontSize: 14 }}>
            <strong>Reason:</strong> {order.review_notes}
          </div>
        )}
      </div>

      {!order.storage_url && allowUpload && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>1. Upload your artwork</h3>
          <p className="muted" style={{ fontSize: 14 }}>
            JPG, PNG, or MP4. Sized to match the display gives the best look.
          </p>
          <label className="row" style={{ cursor: 'pointer' }}>
            <input type="file" accept="image/*,video/*" onChange={onUpload} hidden />
            <span
              style={{
                background: 'var(--accent)',
                color: 'white',
                padding: '10px 16px',
                borderRadius: 6,
                fontSize: 14,
                display: 'inline-block',
              }}
            >
              {uploading ? 'Uploading…' : '+ Upload artwork'}
            </span>
          </label>
        </div>
      )}

      {order.storage_url && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Your artwork</h3>
          <img
            src={order.storage_url}
            alt="your artwork"
            style={{ maxWidth: '100%', borderRadius: 4, border: '1px solid var(--border)' }}
          />
          {warnings.length > 0 && (
            <div style={{ marginTop: 12, padding: 12, background: 'rgba(230, 181, 74, 0.1)', borderRadius: 6, fontSize: 13 }}>
              <strong style={{ color: 'var(--yellow)' }}>Heads up:</strong>
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
              {allowUpload && (
                <div style={{ marginTop: 8 }}>
                  <label className="row" style={{ cursor: 'pointer' }}>
                    <input type="file" accept="image/*,video/*" onChange={onUpload} hidden />
                    <span style={{ color: 'var(--accent)', textDecoration: 'underline', fontSize: 13 }}>
                      Upload a replacement
                    </span>
                  </label>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>2. Payment</h3>
        {order.paid_at ? (
          <div>✓ Payment received {new Date(order.paid_at).toLocaleDateString()}</div>
        ) : (
          <div className="muted">
            A Holm Graphics team member will contact <strong>{order.advertiser_email}</strong> within one business day to take payment and confirm your booking.
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>3. Approval</h3>
        {order.status === 'pending_review' && <div>Your submission is in our review queue. We'll email you when it's approved.</div>}
        {order.status === 'approved' && <div>✓ Approved! Your ad is scheduled to run on the dates shown above.</div>}
        {order.status === 'active' && <div>✓ Your ad is currently running.</div>}
        {order.status === 'rejected' && <div style={{ color: 'var(--red)' }}>Your submission was not approved.</div>}
        {order.status === 'pending_payment' && <div className="muted">Waiting for payment before review can start.</div>}
      </div>

      <p className="muted" style={{ fontSize: 13, marginTop: 24, textAlign: 'center' }}>
        Bookmark this page to check status. Any questions, reply to the confirmation email or contact Holm Graphics directly.
      </p>
    </div>
  );
}
