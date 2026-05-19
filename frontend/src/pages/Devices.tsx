import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { devices as devicesApi } from '../api/endpoints';
import type { Device } from '../types';

export default function Devices() {
  const [list, setList] = useState<Device[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', deviceKey: '', ipAddress: '', port: 5000, location: '' });

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
        deviceKey: form.deviceKey,
        ipAddress: form.ipAddress,
        port: form.port,
        location: form.location || undefined,
      } as any);
      setShowForm(false);
      setForm({ name: '', deviceKey: '', ipAddress: '', port: 5000, location: '' });
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

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
            <div style={{ flex: 2 }}>
              <label>IP address</label>
              <input
                value={form.ipAddress}
                onChange={(e) => setForm({ ...form, ipAddress: e.target.value })}
                placeholder="192.168.1.100"
                required
              />
            </div>
            <div style={{ flex: 1 }}>
              <label>Port</label>
              <input
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: parseInt(e.target.value, 10) || 5000 })}
              />
            </div>
          </div>
          <div>
            <label>Device key (from QR sticker)</label>
            <input
              value={form.deviceKey}
              onChange={(e) => setForm({ ...form, deviceKey: e.target.value })}
              required
            />
          </div>
          <button type="submit">Register</button>
        </form>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>IP</th>
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
                <td>{d.ip_address}:{d.port}</td>
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
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
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
