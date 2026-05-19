import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { devices as devicesApi } from '../api/endpoints';
import type { Device, DeviceStatus } from '../types';

export default function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [device, setDevice] = useState<Device | null>(null);
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brightness, setBrightness] = useState(80);

  useEffect(() => {
    if (!id) return;
    devicesApi.get(id).then((d) => {
      setDevice(d);
    }).catch((e) => setErr((e as Error).message));
  }, [id]);

  if (!device) return <div>{err ? <div className="error-banner">{err}</div> : 'Loading…'}</div>;

  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <Link to="/devices" className="muted">← Back to devices</Link>
          <h1 style={{ margin: '4px 0 0' }}>{device.name}</h1>
        </div>
        <span className={`pill ${device.online ? 'online' : 'offline'}`}>
          {device.online ? 'online' : 'offline'}
        </span>
      </div>

      {err && <div className="error-banner">{err}</div>}

      <div className="row" style={{ gap: 16, alignItems: 'stretch' }}>
        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Device info</h3>
          <div className="stack">
            <div><span className="muted">Model:</span> {device.model ?? '—'}</div>
            <div><span className="muted">Firmware:</span> {device.firmware ?? '—'}</div>
            <div><span className="muted">Address:</span> {device.ip_address}:{device.port}</div>
            <div><span className="muted">Device key:</span> <code>{device.device_key}</code></div>
            <div><span className="muted">Location:</span> {device.location ?? '—'}</div>
            <div><span className="muted">Resolution:</span> {device.width_px && device.height_px ? `${device.width_px}×${device.height_px}` : '—'}</div>
          </div>
        </div>

        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Live status</h3>
          {status ? (
            <div className="stack">
              <div><span className="muted">Brightness:</span> {status.brightness}%</div>
              <div><span className="muted">Temperature:</span> {status.temperatureC ?? '—'}°C</div>
              <div><span className="muted">Playing:</span> {status.currentPlaylistId ?? '—'}</div>
              <div><span className="muted">Uptime:</span> {status.uptimeSec ?? '—'}s</div>
            </div>
          ) : (
            <div className="muted">Click "Refresh status" to fetch.</div>
          )}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Controls</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button
            disabled={busy}
            onClick={() => action(async () => {
              const r = await devicesApi.ping(device.id);
              setDevice({ ...device, online: true, firmware: (r.info as any).firmware ?? device.firmware });
            })}
          >
            Ping
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => action(async () => setStatus(await devicesApi.status(device.id)))}
          >
            Refresh status
          </button>
          <button className="secondary" disabled={busy} onClick={() => action(() => devicesApi.stop(device.id))}>
            Stop playback
          </button>
          <button className="danger" disabled={busy} onClick={() => action(() => devicesApi.reboot(device.id))}>
            Reboot
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`Delete device "${device.name}"? This does not affect the controller itself.`)) return;
              await action(async () => {
                await devicesApi.remove(device.id);
                navigate('/devices');
              });
            }}
          >
            Delete
          </button>
        </div>
        <div style={{ marginTop: 16 }}>
          <label>Brightness: {brightness}%</label>
          <div className="row" style={{ gap: 12 }}>
            <input
              type="range"
              min={0}
              max={100}
              value={brightness}
              onChange={(e) => setBrightness(parseInt(e.target.value, 10))}
              style={{ flex: 1 }}
            />
            <button
              disabled={busy}
              onClick={() => action(() => devicesApi.setBrightness(device.id, brightness))}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
