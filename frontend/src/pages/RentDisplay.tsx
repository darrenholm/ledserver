import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { publicRentals } from '../api/endpoints';
import type { RentableDisplayDetail } from '../types';

interface FormState {
  advertiserName: string;
  advertiserEmail: string;
  advertiserPhone: string;
  advertiserBusiness: string;
  advertiserNotes: string;
  startDate: string;
  durationUnit: 'day' | 'week' | 'month';
  durationCount: number;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function RentDisplay() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [display, setDisplay] = useState<RentableDisplayDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>({
    advertiserName: '',
    advertiserEmail: '',
    advertiserPhone: '',
    advertiserBusiness: '',
    advertiserNotes: '',
    startDate: today(),
    durationUnit: 'week',
    durationCount: 1,
  });

  useEffect(() => {
    if (!id) return;
    publicRentals
      .getDisplay(id)
      .then(setDisplay)
      .catch((e) => setErr((e as Error).message));
  }, [id]);

  const priceEstimate = useMemo(() => {
    if (!display) return null;
    const rateStr =
      form.durationUnit === 'day'
        ? display.daily_rate
        : form.durationUnit === 'week'
          ? display.weekly_rate
          : display.monthly_rate;
    if (!rateStr) return null;
    const total = parseFloat(rateStr) * form.durationCount;
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: display.rental_currency }).format(total);
  }, [display, form.durationUnit, form.durationCount]);

  if (!display) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px' }}>
        <Link to="/rent" className="muted">← All displays</Link>
        {err ? <div className="error-banner">{err}</div> : <div className="muted">Loading…</div>}
      </div>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await publicRentals.create({
        deviceId: display.id,
        advertiserName: form.advertiserName,
        advertiserEmail: form.advertiserEmail,
        advertiserPhone: form.advertiserPhone || undefined,
        advertiserBusiness: form.advertiserBusiness || undefined,
        advertiserNotes: form.advertiserNotes || undefined,
        startDate: form.startDate,
        durationUnit: form.durationUnit,
        durationCount: form.durationCount,
      });
      navigate(`/rent/orders/${res.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px' }}>
      <Link to="/rent" className="muted" style={{ fontSize: 13 }}>← All displays</Link>
      <h1 style={{ margin: '8px 0 0' }}>{display.name}</h1>
      {display.location && <div className="muted" style={{ marginBottom: 16 }}>{display.location}</div>}

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="muted" style={{ fontSize: 13 }}>Specs</div>
        <div>
          {display.width_px && display.height_px ? `${display.width_px} × ${display.height_px} px` : 'Resolution TBD'}
          {display.model && ` · ${display.model}`}
        </div>
        {display.bookedWindows.length > 0 && (
          <>
            <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>Already booked</div>
            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
              {display.bookedWindows.map((b, i) => (
                <li key={i} style={{ fontSize: 13 }}>{b.start_date} → {b.end_date}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      <form onSubmit={onSubmit} className="card stack">
        <h3 style={{ marginTop: 0 }}>Book this display</h3>

        <div className="row" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Your name</label>
            <input value={form.advertiserName} onChange={(e) => setForm({ ...form, advertiserName: e.target.value })} required />
          </div>
          <div style={{ flex: 1 }}>
            <label>Business</label>
            <input value={form.advertiserBusiness} onChange={(e) => setForm({ ...form, advertiserBusiness: e.target.value })} />
          </div>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Email</label>
            <input type="email" value={form.advertiserEmail} onChange={(e) => setForm({ ...form, advertiserEmail: e.target.value })} required />
          </div>
          <div style={{ flex: 1 }}>
            <label>Phone</label>
            <input value={form.advertiserPhone} onChange={(e) => setForm({ ...form, advertiserPhone: e.target.value })} />
          </div>
        </div>

        <div className="row" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Start date</label>
            <input type="date" min={today()} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
          </div>
          <div style={{ flex: 1 }}>
            <label>Duration</label>
            <div className="row" style={{ gap: 8 }}>
              <input
                type="number"
                min={1}
                max={52}
                value={form.durationCount}
                onChange={(e) => setForm({ ...form, durationCount: parseInt(e.target.value, 10) || 1 })}
                style={{ width: 80 }}
              />
              <select
                value={form.durationUnit}
                onChange={(e) => setForm({ ...form, durationUnit: e.target.value as 'day' | 'week' | 'month' })}
              >
                <option value="day">day(s)</option>
                <option value="week">week(s)</option>
                <option value="month">month(s)</option>
              </select>
            </div>
          </div>
        </div>

        <div>
          <label>Notes for our review team (optional)</label>
          <textarea
            value={form.advertiserNotes}
            onChange={(e) => setForm({ ...form, advertiserNotes: e.target.value })}
            rows={3}
          />
        </div>

        {priceEstimate && (
          <div className="card" style={{ background: 'var(--surface-2)', padding: 12 }}>
            <span className="muted">Estimated total: </span>
            <strong style={{ fontSize: 16 }}>{priceEstimate}</strong>
          </div>
        )}

        {err && <div className="error-banner">{err}</div>}

        <button type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Continue → upload artwork'}</button>
      </form>
    </div>
  );
}
