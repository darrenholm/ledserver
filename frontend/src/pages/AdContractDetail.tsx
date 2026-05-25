import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { adContracts as adContractsApi, type AdContract, type UnattachedRental } from '../api/endpoints';

/**
 * Admin detail page for a single ad contract. Shows:
 *   - Header: client + device + status pill
 *   - Term + billing card with editable auto_renew, end_date, amount, billing email
 *   - Ads list (rentals attached to this contract)
 *   - Renewal status (next-invoice date, renewal_invoice_id if minted)
 *
 * For `owner_perpetual` contracts the term/billing card is read-only — those
 * rows are managed via devices.owner_client_id on the parent device.
 */
export default function AdContractDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [contract, setContract] = useState<AdContract | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editable form state — only used for 'rental' contracts.
  const [endDate, setEndDate] = useState('');
  const [amountDollars, setAmountDollars] = useState('');
  const [autoRenew, setAutoRenew] = useState(false);
  const [billingEmail, setBillingEmail] = useState('');
  const [notes, setNotes] = useState('');
  // Attach-existing-ad picker state.
  const [showAttach, setShowAttach] = useState(false);
  const [available, setAvailable] = useState<UnattachedRental[]>([]);
  const [attachBusy, setAttachBusy] = useState<string | null>(null); // rental id being attached

  useEffect(() => {
    if (!id) return;
    adContractsApi
      .get(id)
      .then((c) => {
        setContract(c);
        setEndDate(c.end_date ?? '');
        setAmountDollars(c.amount_cents != null ? (c.amount_cents / 100).toFixed(2) : '');
        setAutoRenew(c.auto_renew);
        setBillingEmail(c.billing_contact_email ?? '');
        setNotes(c.notes ?? '');
      })
      .catch((e) => setErr((e as Error).message));
  }, [id]);

  if (!contract) {
    return <div>{err ? <div className="error-banner">{err}</div> : 'Loading…'}</div>;
  }

  const isOwnerPerpetual = contract.contract_type === 'owner_perpetual';

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const amountCents = amountDollars.trim() === '' ? null : Math.round(parseFloat(amountDollars) * 100);
      const updated = await adContractsApi.update(contract.id, {
        endDate: endDate || null,
        amountCents,
        autoRenew,
        billingContactEmail: billingEmail.trim() || null,
        notes: notes.trim() || null,
      });
      setContract({ ...contract, ...updated, rentals: contract.rentals });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const refreshContract = async () => {
    if (!id) return;
    const fresh = await adContractsApi.get(id);
    setContract(fresh);
  };

  const openAttach = async () => {
    if (!contract) return;
    setShowAttach(true);
    try {
      const list = await adContractsApi.unattachedRentals(contract.device_id);
      setAvailable(list);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const attach = async (rentalId: string) => {
    if (!contract) return;
    setAttachBusy(rentalId);
    setErr(null);
    try {
      await adContractsApi.attachRental(contract.id, rentalId);
      // Refresh both the contract (to show the new rental in the list) and
      // the picker (to remove the now-attached rental from the available pool).
      setAvailable((prev) => prev.filter((r) => r.id !== rentalId));
      await refreshContract();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAttachBusy(null);
    }
  };

  const detach = async (rentalId: string) => {
    if (!contract) return;
    if (!confirm('Unlink this ad from the contract? The ad stays on the screen, but it won\'t be attributed to this client anymore.')) return;
    setBusy(true);
    setErr(null);
    try {
      await adContractsApi.detachRental(contract.id, rentalId);
      await refreshContract();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!confirm('Cancel this contract? Rentals stay attached for history.')) return;
    setBusy(true);
    setErr(null);
    try {
      await adContractsApi.cancel(contract.id);
      navigate(`/devices/${contract.device_id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const statusColor =
    contract.status === 'active'    ? '#dcfce7' :
    contract.status === 'expired'   ? '#fef3c7' :
                                       '#fee2e2';

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h2 style={{ margin: '0 0 4px 0' }}>
            Ad contract <span className="muted" style={{ fontSize: 14 }}>#{contract.id.slice(0, 8)}</span>
          </h2>
          <div className="muted" style={{ fontSize: 14 }}>
            Client #{contract.client_id} · {' '}
            <Link to={`/devices/${contract.device_id}`}>
              {contract.device_name ?? contract.device_id.slice(0, 8)}
            </Link>
            {contract.device_location && ` · ${contract.device_location}`}
          </div>
        </div>
        <span
          style={{
            fontSize: 13,
            padding: '4px 12px',
            borderRadius: 4,
            background: statusColor,
            alignSelf: 'flex-start',
          }}
        >
          {contract.status}{isOwnerPerpetual && ' · owner-perpetual'}
        </span>
      </div>

      {err && <div className="error-banner">{err}</div>}

      {/* --- Term + billing card --- */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Term &amp; billing</h3>

        {isOwnerPerpetual && (
          <div className="muted" style={{ fontSize: 13, marginBottom: 12, padding: 8, background: '#f3f4f6', borderRadius: 4 }}>
            This is an owner-perpetual contract — created automatically when the
            screen was assigned to this client. Term and billing fields can't be
            edited here; clear ownership on the device to retire it.
          </div>
        )}

        <div className="row" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Start date</label>
            <input value={contract.start_date} disabled />
          </div>
          <div style={{ flex: 1 }}>
            <label>End date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={isOwnerPerpetual || busy}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Term</label>
            <input
              value={contract.term_count && contract.term_unit ? `${contract.term_count} × ${contract.term_unit}` : '—'}
              disabled
            />
          </div>
        </div>

        <div className="row" style={{ gap: 12, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label>Amount ({contract.currency})</label>
            <input
              value={amountDollars}
              onChange={(e) => setAmountDollars(e.target.value)}
              inputMode="decimal"
              disabled={isOwnerPerpetual || busy}
              placeholder={isOwnerPerpetual ? '—' : '1200.00'}
            />
          </div>
          <div style={{ flex: 2 }}>
            <label>Billing contact email (overrides client default)</label>
            <input
              value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)}
              disabled={isOwnerPerpetual || busy}
              placeholder="accounts@client.com"
            />
          </div>
        </div>

        <div style={{ marginTop: 8 }}>
          <label>Notes</label>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={isOwnerPerpetual || busy}
          />
        </div>

        <label className="row" style={{ gap: 8, marginTop: 12, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={autoRenew}
            onChange={(e) => setAutoRenew(e.target.checked)}
            disabled={isOwnerPerpetual || busy}
            style={{ width: 'auto' }}
          />
          <span>
            Auto-renew — mints a QBO invoice ~30 days before <code>end_date</code>.{' '}
            <span className="muted" style={{ fontSize: 12 }}>
              (Dormant until the server-side master switch{' '}
              <code>RENEWAL_AUTO_INVOICE</code> is flipped to <code>true</code>.)
            </span>
          </span>
        </label>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          {!isOwnerPerpetual && (
            <button onClick={cancel} disabled={busy} style={{ background: '#fee2e2', color: '#dc2626' }}>
              Cancel contract
            </button>
          )}
          <button onClick={save} disabled={busy || isOwnerPerpetual}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* --- Renewal status --- */}
      {!isOwnerPerpetual && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Renewal status</h3>
          {contract.renewal_invoiced_at ? (
            <div>
              <div>
                Invoice minted on{' '}
                <strong>{new Date(contract.renewal_invoiced_at).toLocaleDateString()}</strong>
              </div>
              {contract.renewal_invoice_id && (
                <div className="muted" style={{ fontSize: 13 }}>
                  QBO Invoice ID: <code>{contract.renewal_invoice_id}</code>
                </div>
              )}
            </div>
          ) : contract.auto_renew && contract.end_date ? (
            <div className="muted" style={{ fontSize: 14 }}>
              Will invoice when within 30 days of {contract.end_date} —{' '}
              <em>contingent on master switch.</em>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 14 }}>
              Auto-renew off — no invoice will be generated.
            </div>
          )}
        </div>
      )}

      {/* --- Ads (rentals) under this contract --- */}
      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Ads under this contract</h3>
          <button onClick={openAttach} disabled={busy}>+ Attach existing ad</button>
        </div>
        {!contract.rentals || contract.rentals.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No ads attached yet.</div>
        ) : (
          <table style={{ width: '100%', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                <th>Status</th>
                <th>Window</th>
                <th>Daypart</th>
                <th>Amount</th>
                <th>Advertiser</th>
                <th></th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {contract.rentals.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td>{r.status}</td>
                  <td>
                    {r.start_date && r.end_date
                      ? `${r.start_date} → ${r.end_date}`
                      : <span className="muted">unscheduled</span>}
                  </td>
                  <td>{r.start_time?.slice(0, 5)}–{r.end_time?.slice(0, 5)}</td>
                  <td>${(r.amount_cents / 100).toFixed(2)} {r.currency}</td>
                  <td>{r.advertiser_name}</td>
                  <td>
                    {r.artwork_url && (
                      <a href={r.artwork_url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                        artwork
                      </a>
                    )}
                  </td>
                  <td>
                    <Link to={`/rentals/${r.id}`} style={{ fontSize: 13 }}>Open →</Link>
                  </td>
                  <td>
                    <button
                      onClick={() => detach(r.id)}
                      disabled={busy}
                      style={{ fontSize: 12, padding: '2px 8px' }}
                      title="Unlink from this contract (the ad keeps running, just isn't attributed)"
                    >
                      Detach
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- Attach existing ad picker --- */}
      {showAttach && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setShowAttach(false)}
        >
          <div
            className="card"
            style={{ maxWidth: 600, width: '90%', maxHeight: '90vh', overflowY: 'auto', background: 'white' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row between" style={{ marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Attach existing ad</h3>
              <button onClick={() => setShowAttach(false)}>✕</button>
            </div>
            <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
              Ads on this screen that aren't yet attributed to any contract. Click "Attach" to link an ad to this contract.
            </div>
            {available.length === 0 ? (
              <div className="muted">No unattached ads on this screen.</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {available.map((r) => (
                  <li key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid #eee' }}>
                    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                      {r.artwork_url && r.artwork_mime?.startsWith('image/') && (
                        <img
                          src={r.artwork_url}
                          alt=""
                          style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4, border: '1px solid #ddd' }}
                        />
                      )}
                      <div style={{ flex: 1, fontSize: 13 }}>
                        <div><strong>{r.advertiser_name}</strong> {r.advertiser_business && <span className="muted">({r.advertiser_business})</span>}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {r.start_date && r.end_date ? `${r.start_date} → ${r.end_date}` : <em>unscheduled</em>}
                          {' · '}{r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}
                          {' · '}${(r.amount_cents / 100).toFixed(2)} {r.currency}
                          {' · '}<span style={{ fontStyle: 'italic' }}>{r.status}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => attach(r.id)}
                        disabled={attachBusy !== null}
                      >
                        {attachBusy === r.id ? 'Attaching…' : 'Attach'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
