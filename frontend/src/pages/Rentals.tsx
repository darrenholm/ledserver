import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { rentals as rentalsApi } from '../api/endpoints';
import type { AdminRental, RentalStatus } from '../types';

const FILTERS: { label: string; value: RentalStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pending payment', value: 'pending_payment' },
  { label: 'Pending review', value: 'pending_review' },
  { label: 'Approved', value: 'approved' },
  { label: 'Active', value: 'active' },
  { label: 'Rejected', value: 'rejected' },
];

function fmtMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
}

export default function Rentals() {
  const [list, setList] = useState<AdminRental[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<RentalStatus | 'all'>('all');

  useEffect(() => {
    rentalsApi
      .list(filter === 'all' ? undefined : filter)
      .then(setList)
      .catch((e) => setErr((e as Error).message));
  }, [filter]);

  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Ad rentals</h1>
        <select value={filter} onChange={(e) => setFilter(e.target.value as any)} style={{ width: 200 }}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>

      {err && <div className="error-banner">{err}</div>}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Submitted</th>
              <th>Advertiser</th>
              <th>Display</th>
              <th>Window</th>
              <th>Total</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td className="muted">{new Date(r.created_at).toLocaleDateString()}</td>
                <td>
                  <div>{r.advertiser_name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{r.advertiser_business || r.advertiser_email}</div>
                </td>
                <td>{r.device_name}</td>
                <td className="muted" style={{ fontSize: 13 }}>{r.start_date} → {r.end_date}</td>
                <td>{fmtMoney(r.amount_cents, r.currency)}</td>
                <td>
                  <span className="pill" style={{
                    background: statusBg(r.status),
                    color: statusFg(r.status),
                  }}>
                    {r.status.replace('_', ' ')}
                  </span>
                </td>
                <td>
                  <Link to={`/rentals/${r.id}`}>Review →</Link>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No rentals match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function statusBg(s: string): string {
  if (s === 'approved' || s === 'active') return 'rgba(63, 191, 111, 0.15)';
  if (s === 'rejected' || s === 'cancelled') return 'rgba(227, 93, 93, 0.15)';
  if (s === 'pending_review') return 'rgba(230, 181, 74, 0.15)';
  return 'rgba(154, 161, 173, 0.15)';
}
function statusFg(s: string): string {
  if (s === 'approved' || s === 'active') return 'var(--green)';
  if (s === 'rejected' || s === 'cancelled') return 'var(--red)';
  if (s === 'pending_review') return 'var(--yellow)';
  return 'var(--text-dim)';
}
