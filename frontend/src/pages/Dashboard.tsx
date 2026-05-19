import { useEffect, useState } from 'react';
import { devices, logs as logsApi } from '../api/endpoints';
import type { Device, LogEntry } from '../types';

export default function Dashboard() {
  const [deviceList, setDevices] = useState<Device[]>([]);
  const [recent, setRecent] = useState<LogEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([devices.list(), logsApi.list({ limit: 20 })])
      .then(([d, l]) => {
        setDevices(d);
        setRecent(l);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const online = deviceList.filter((d) => d.online).length;

  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Dashboard</h1>
      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ gap: 16 }}>
        <div className="card" style={{ flex: 1 }}>
          <div className="muted">Total devices</div>
          <div style={{ fontSize: 32, fontWeight: 600 }}>{deviceList.length}</div>
        </div>
        <div className="card" style={{ flex: 1 }}>
          <div className="muted">Online</div>
          <div style={{ fontSize: 32, fontWeight: 600, color: 'var(--green)' }}>{online}</div>
        </div>
        <div className="card" style={{ flex: 1 }}>
          <div className="muted">Offline</div>
          <div style={{ fontSize: 32, fontWeight: 600, color: 'var(--red)' }}>
            {deviceList.length - online}
          </div>
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent activity</h3>
        {recent.length === 0 && <div className="muted">No log entries yet.</div>}
        {recent.length > 0 && (
          <table>
            <thead>
              <tr>
                <th style={{ width: 180 }}>Time</th>
                <th style={{ width: 70 }}>Level</th>
                <th style={{ width: 80 }}>Source</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((l) => (
                <tr key={l.id}>
                  <td className="muted">{new Date(l.ts).toLocaleString()}</td>
                  <td>{l.level}</td>
                  <td>{l.source}</td>
                  <td>{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
