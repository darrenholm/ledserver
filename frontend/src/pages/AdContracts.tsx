import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { adContracts as adContractsApi, type AdContract } from '../api/endpoints';

/**
 * Top-level list of every ad contract across all devices in the current
 * org scope. Used as a hub when admin wants to find a contract without
 * having to remember which device it lives on.
 *
 * Filters: by status (active / expired / cancelled) and by contract type
 * (rental vs owner_perpetual). Client name lookups are deferred — the
 * shop-api search endpoint is keyword-based, not id-based, so for now we
 * just show "Client #N" and link out to the contract detail (which shows
 * full info).
 */
export default function AdContracts() {
  const [contracts, setContracts] = useState<AdContract[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'expired' | 'cancelled'>('active');
  const [typeFilter, setTypeFilter] = useState<'all' | 'rental' | 'owner_perpetual'>('all');

  useEffect(() => {
    adContractsApi
      .list(statusFilter === 'all' ? {} : { status: statusFilter })
      .then(setContracts)
      .catch((e) => setErr((e as Error).message));
  }, [statusFilter]);

  const filtered = useMemo(() => {
    if (typeFilter === 'all') return contracts;
    return contracts.filter((c) => c.contract_type === typeFilter);
  }, [contracts, typeFilter]);

  return (
    <div className="stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Ad contracts</h2>
        <div className="muted" style={{ fontSize: 13 }}>
          {filtered.length} contract{filtered.length === 1 ? '' : 's'}
        </div>
      </div>

      <div className="muted" style={{ fontSize: 13 }}>
        Each contract is the commercial agreement between a client and a screen.
        Create a new contract from a <Link to="/devices">device's detail page</Link>.
      </div>

      {err && <div className="error-banner">{err}</div>}

      <div className="card">
        <div className="row" style={{ gap: 16, alignItems: 'center', marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 12 }}>Status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
              <option value="active">Active</option>
              <option value="expired">Expired</option>
              <option value="cancelled">Cancelled</option>
              <option value="all">All</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12 }}>Type</label>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}>
              <option value="all">All</option>
              <option value="rental">Rental</option>
              <option value="owner_perpetual">Owner-perpetual</option>
            </select>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            No contracts match the current filters.
          </div>
        ) : (
          <table style={{ width: '100%', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '6px 8px' }}>Client</th>
                <th style={{ padding: '6px 8px' }}>Screen</th>
                <th style={{ padding: '6px 8px' }}>Type</th>
                <th style={{ padding: '6px 8px' }}>Term</th>
                <th style={{ padding: '6px 8px' }}>Amount</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px' }}>Auto-renew</th>
                <th style={{ padding: '6px 8px' }}>Ads</th>
                <th style={{ padding: '6px 8px' }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px' }}>
                    Client #{c.client_id}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <Link to={`/devices/${c.device_id}`}>
                      {c.device_name ?? c.device_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {c.contract_type === 'owner_perpetual' ? 'owner' : 'rental'}
                    </span>
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    {c.contract_type === 'owner_perpetual'
                      ? <span className="muted">perpetual</span>
                      : `${c.start_date} → ${c.end_date ?? '?'}`}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    {c.amount_cents != null
                      ? `$${(c.amount_cents / 100).toFixed(2)} ${c.currency}`
                      : <span className="muted">—</span>}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <span style={{
                      fontSize: 12,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: c.status === 'active' ? '#dcfce7' : c.status === 'expired' ? '#fef3c7' : '#fee2e2',
                      color: c.status === 'active' ? '#166534' : c.status === 'expired' ? '#92400e' : '#991b1b',
                    }}>
                      {c.status}
                    </span>
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    {c.contract_type === 'owner_perpetual' ? '—' : (c.auto_renew ? '✓' : '—')}
                  </td>
                  <td style={{ padding: '6px 8px' }}>{c.rental_count ?? 0}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <Link to={`/ad-contracts/${c.id}`} style={{ fontSize: 13 }}>Open →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
