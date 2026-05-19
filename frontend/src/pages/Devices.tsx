import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { devices as devicesApi } from '../api/endpoints';
import { useAuth } from '../auth';
import type { Device, DeviceProvider } from '../types';

interface FormState {
  name: string;
  provider: DeviceProvider;
  deviceKey: string;
  ipAddress: string;
  port: number;
  location: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  provider: 'vnnox',
  deviceKey: '',
  ipAddress: '',
  port: 5000,
  location: '',
};

export default function Devices() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [list, setList] = useState<Device[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const refresh = () =>
    devicesApi
      .list()
      .then(setList)
      .catch((e) => setErr((e as Error).message));

  useEffect(() => {
    refresh();
  }, []);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await devicesApi.create({
        name: form.name,
        provider: form.provider,
        deviceKey: form.deviceKey,
        ipAddress: form.provider === 'lan_direct' ? form.ipAddress : undefined,
        port: form.provider === 'lan_direct' ? form.port : undefined,
        location: form.location || undefined,
      } as any);
      setShowForm(false);
      setForm(EMPTY_FORM);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const providerLabel = (p: DeviceProvider) =>
    p === 'vnnox' ? 'VNNOX Cloud' : p === 'lan_direct' ? 'LAN direct' : 'Mock';

  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Devices</h1>
        <button onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ Register device'}
        </button>
      </div>

      {err && <div className="error-banner">{err}</div>}

      {showForm && (
        <form onSubmit={onCreate} className="card stack">
          <div className="row" style={{ gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div style={{ flex: 1 }}>
              <label>Location</label>
              <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </div>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label>Provider</label>
              <select
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value as DeviceProvider })}
              >
                <option value="vnnox">VNNOX Cloud (recommended)</option>
                {isSuperAdmin && <option value="lan_direct">LAN direct (in-shop diagnostics)</option>}
              </select>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {form.provider === 'vnnox'
                  ? 'Controls the device via NovaStar’s cloud API. Use this for customer screens.'
                  : 'Direct LAN connection on port 5200. Diagnostics only — requires same-LAN reachability.'}
              </div>
            </div>
            {form.provider === 'lan_direct' && (
              <>
                <div style={{ flex: 2 }}>
                  <label>IP address</label>
                  <input
                    value={form.ipAddress}
                    onChange={(e) => setForm({ ...form, ipAddress: e.target.value })}
                    placeholder="10.10.1.173"
                    required
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label>Port</label>
                  <input
                    type="number"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: parseInt(e.target.value, 10) || 5200 })}
                  />
                </div>
              </>
            )}
          </div>
          <div>
            <label>
              {form.provider === 'vnnox'
                ? 'Device serial number (SN)'
                : 'Device key (from QR sticker)'}
            </label>
            <input
              value={form.deviceKey}
              onChange={(e) => setForm({ ...form, deviceKey: e.target.value })}
              placeholder={form.provider === 'vnnox' ? '2YHA23504W4A10034783-00' : ''}
              required
            />
            {form.provider === 'vnnox' && (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                The SN as listed in VNNOX (Screen list). Often printed on the controller label too.
              </div>
            )}
          </div>
          <button type="submit">Register</button>
        </form>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Provider</th>
              <th>SN / Key</th>
              <th>Status</th>
              <th>Location</th>
              <th>Last seen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link to={`/devices/${d.id}`}>{d.name}</Link>
                  <div className="muted" style={{ fontSize: 12 }}>{d.model ?? '—'}</div>
                </td>
                <td>{providerLabel(d.provider)}</td>
                <td><code style={{ fontSize: 12 }}>{d.device_key}</code></td>
                <td>
                  <span className={`pill ${d.online ? 'online' : 'offline'}`}>
                    {d.online ? 'online' : 'offline'}
                  </span>
                </td>
                <td>{d.location ?? '—'}</td>
                <td className="muted">
                  {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never'}
                </td>
                <td>
                  <Link to={`/devices/${d.id}`}>Manage →</Link>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No devices registered yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
