import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { publicRentals } from '../api/endpoints';
import type { RentableDisplay } from '../types';

function formatRate(d: RentableDisplay): string {
  const fmt = (n: string | null) =>
    n ? new Intl.NumberFormat('en-CA', { style: 'currency', currency: d.rental_currency }).format(parseFloat(n)) : null;
  const day = fmt(d.daily_rate);
  const week = fmt(d.weekly_rate);
  const month = fmt(d.monthly_rate);
  const parts: string[] = [];
  if (day) parts.push(`${day}/day`);
  if (week) parts.push(`${week}/week`);
  if (month) parts.push(`${month}/month`);
  return parts.join(' · ') || 'Contact for pricing';
}

export default function Rent() {
  const [list, setList] = useState<RentableDisplay[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    publicRentals
      .listDisplays()
      .then(setList)
      .catch((e) => setErr((e as Error).message));
  }, []);

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '40px 24px' }}>
      <h1 style={{ marginTop: 0 }}>Advertise on our LED screens</h1>
      <p className="muted" style={{ fontSize: 15 }}>
        Pick a display, choose your dates, upload artwork, and our team will get your ad on screen within one business day.
      </p>

      {err && <div className="error-banner">{err}</div>}

      {!list && !err && <div className="muted">Loading…</div>}

      {list && list.length === 0 && (
        <div className="card" style={{ marginTop: 24 }}>
          <h3 style={{ marginTop: 0 }}>No screens are listed for rent right now</h3>
          <div className="muted">Check back soon, or contact us directly.</div>
        </div>
      )}

      {list && list.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginTop: 24 }}>
          {list.map((d) => (
            <Link
              key={d.id}
              to={`/rent/displays/${d.id}`}
              className="card"
              style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
            >
              <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>{d.name}</div>
              {d.location && <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>{d.location}</div>}
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                {d.width_px && d.height_px ? `${d.width_px} × ${d.height_px} px` : 'Resolution TBD'}
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--accent)' }}>{formatRate(d)}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
