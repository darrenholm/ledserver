import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import SunCalc from 'suncalc';
import { devices as devicesApi } from '../api/endpoints';
import type { Device, DeviceStatus } from '../types';

interface BrightnessFormState {
  autoBrightnessEnabled: boolean;
  latitude: string;
  longitude: string;
  brightnessDay: number;
  brightnessNight: number;
  brightnessOffsetMinutes: number;
}

interface RentalFormState {
  isRentable: boolean;
  dailyRate: string;
  weeklyRate: string;
  monthlyRate: string;
  currency: string;
}

interface DetailsFormState {
  model: string;
  firmware: string;
  widthPx: string;
  heightPx: string;
  location: string;
}

function deviceToDetailsForm(d: Device): DetailsFormState {
  return {
    model: d.model ?? '',
    firmware: d.firmware ?? '',
    widthPx: d.width_px ? String(d.width_px) : '',
    heightPx: d.height_px ? String(d.height_px) : '',
    location: d.location ?? '',
  };
}

function deviceToRentalForm(d: Device): RentalFormState {
  return {
    isRentable: d.is_rentable,
    dailyRate: d.daily_rate ?? '',
    weeklyRate: d.weekly_rate ?? '',
    monthlyRate: d.monthly_rate ?? '',
    currency: d.rental_currency ?? 'CAD',
  };
}

function deviceToBrightnessForm(d: Device): BrightnessFormState {
  return {
    autoBrightnessEnabled: d.auto_brightness_enabled,
    latitude: d.latitude ?? '',
    longitude: d.longitude ?? '',
    brightnessDay: d.brightness_day,
    brightnessNight: d.brightness_night,
    brightnessOffsetMinutes: d.brightness_offset_minutes,
  };
}

function formatTime(d: Date | null): string {
  if (!d || isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [device, setDevice] = useState<Device | null>(null);
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brightness, setBrightness] = useState(80);
  const [bForm, setBForm] = useState<BrightnessFormState | null>(null);
  const [rForm, setRForm] = useState<RentalFormState | null>(null);
  const [dForm, setDForm] = useState<DetailsFormState | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);

  useEffect(() => {
    if (!id) return;
    devicesApi
      .get(id)
      .then((d) => {
        setDevice(d);
        setBForm(deviceToBrightnessForm(d));
        setRForm(deviceToRentalForm(d));
        setDForm(deviceToDetailsForm(d));
      })
      .catch((e) => setErr((e as Error).message));
  }, [id]);

  const sunPreview = useMemo(() => {
    if (!bForm) return null;
    const lat = parseFloat(bForm.latitude);
    const lng = parseFloat(bForm.longitude);
    if (isNaN(lat) || isNaN(lng)) return null;
    const times = SunCalc.getTimes(new Date(), lat, lng);
    const offsetMs = bForm.brightnessOffsetMinutes * 60 * 1000;
    return {
      sunrise: times.sunrise,
      sunset: times.sunset,
      adjustedSunrise: new Date(times.sunrise.getTime() + offsetMs),
      adjustedSunset: new Date(times.sunset.getTime() + offsetMs),
    };
  }, [bForm]);

  if (!device || !bForm || !rForm || !dForm) return <div>{err ? <div className="error-banner">{err}</div> : 'Loading…'}</div>;

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

  const saveBrightnessForm = async () => {
    const latitude = bForm.latitude.trim() === '' ? null : parseFloat(bForm.latitude);
    const longitude = bForm.longitude.trim() === '' ? null : parseFloat(bForm.longitude);
    if (bForm.autoBrightnessEnabled && (latitude === null || longitude === null)) {
      setErr('Latitude and longitude are required when auto-brightness is enabled.');
      return;
    }
    if (latitude !== null && (isNaN(latitude) || latitude < -90 || latitude > 90)) {
      setErr('Latitude must be between -90 and 90.');
      return;
    }
    if (longitude !== null && (isNaN(longitude) || longitude < -180 || longitude > 180)) {
      setErr('Longitude must be between -180 and 180.');
      return;
    }
    await action(async () => {
      const updated = await devicesApi.update(device.id, {
        autoBrightnessEnabled: bForm.autoBrightnessEnabled,
        latitude,
        longitude,
        brightnessDay: bForm.brightnessDay,
        brightnessNight: bForm.brightnessNight,
        brightnessOffsetMinutes: bForm.brightnessOffsetMinutes,
      } as any);
      setDevice(updated);
      setBForm(deviceToBrightnessForm(updated));
    });
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
          <div className="row between" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Device info</h3>
            {!editingDetails ? (
              <button className="secondary" onClick={() => setEditingDetails(true)} style={{ padding: '4px 10px', fontSize: 13 }}>
                Edit
              </button>
            ) : null}
          </div>

          {!editingDetails ? (
            <div className="stack">
              <div><span className="muted">Model:</span> {device.model ?? '—'}</div>
              <div><span className="muted">Firmware:</span> {device.firmware ?? '—'}</div>
              <div><span className="muted">Location:</span> {device.location ?? '—'}</div>
              <div><span className="muted">Resolution:</span> {device.width_px && device.height_px ? `${device.width_px} × ${device.height_px}` : '—'}</div>
              <div><span className="muted">Device key:</span> <code style={{ fontSize: 12 }}>{device.device_key}</code></div>
              {device.provider === 'vnnox' && (
                <div style={{ marginTop: 8 }}>
                  <a href="https://us.vnnox.com" target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
                    Open in VNNOX console ↗
                  </a>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    Firmware upgrades and capture aren't exposed via the public API — use VNNOX directly.
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="stack">
              <div className="muted" style={{ fontSize: 12 }}>
                These are local notes — VNNOX doesn't expose firmware/resolution via its public API, so we let you set them here.
              </div>
              <div>
                <label>Model</label>
                <input value={dForm.model} onChange={(e) => setDForm({ ...dForm, model: e.target.value })} placeholder="Taurus T30" />
              </div>
              <div>
                <label>Firmware</label>
                <input value={dForm.firmware} onChange={(e) => setDForm({ ...dForm, firmware: e.target.value })} placeholder="4.6.2.0201" />
              </div>
              <div>
                <label>Location</label>
                <input value={dForm.location} onChange={(e) => setDForm({ ...dForm, location: e.target.value })} placeholder="20 McNab St, Walkerton ON" />
              </div>
              <div className="row" style={{ gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label>Width (px)</label>
                  <input type="number" value={dForm.widthPx} onChange={(e) => setDForm({ ...dForm, widthPx: e.target.value })} placeholder="480" />
                </div>
                <div style={{ flex: 1 }}>
                  <label>Height (px)</label>
                  <input type="number" value={dForm.heightPx} onChange={(e) => setDForm({ ...dForm, heightPx: e.target.value })} placeholder="240" />
                </div>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <button
                  className="secondary"
                  onClick={() => {
                    setDForm(deviceToDetailsForm(device));
                    setEditingDetails(false);
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      const updated = await devicesApi.update(device.id, {
                        model: dForm.model.trim() || null,
                        firmware: dForm.firmware.trim() || null,
                        location: dForm.location.trim() || null,
                        widthPx: dForm.widthPx.trim() === '' ? null : parseInt(dForm.widthPx, 10),
                        heightPx: dForm.heightPx.trim() === '' ? null : parseInt(dForm.heightPx, 10),
                      } as any);
                      setDevice(updated);
                      setDForm(deviceToDetailsForm(updated));
                      setEditingDetails(false);
                    })
                  }
                >
                  Save
                </button>
              </div>
            </div>
          )}
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
          <div className="row between" style={{ marginBottom: 4 }}>
            <label style={{ margin: 0 }}>Brightness: {brightness}%</label>
            {device.last_applied_brightness !== null && (
              <span className="muted" style={{ fontSize: 12 }}>
                Last applied: {device.last_applied_brightness}%
                {device.last_applied_at && ` · ${new Date(device.last_applied_at).toLocaleString()}`}
              </span>
            )}
          </div>
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
              onClick={() => action(async () => {
                await devicesApi.setBrightness(device.id, brightness);
                // refresh device row so the "Last applied" line updates
                const fresh = await devicesApi.get(device.id);
                setDevice(fresh);
              })}
            >
              Set brightness
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Brightness automation</h3>
          <label className="row" style={{ gap: 8, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={bForm.autoBrightnessEnabled}
              onChange={(e) => setBForm({ ...bForm, autoBrightnessEnabled: e.target.checked })}
              style={{ width: 'auto' }}
            />
            <span>Enabled</span>
          </label>
        </div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Automatically transitions between day and night brightness based on local sunrise / sunset.
        </div>

        <div className="row" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Latitude</label>
            <input
              value={bForm.latitude}
              onChange={(e) => setBForm({ ...bForm, latitude: e.target.value })}
              placeholder="43.4675"
              inputMode="decimal"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Longitude</label>
            <input
              value={bForm.longitude}
              onChange={(e) => setBForm({ ...bForm, longitude: e.target.value })}
              placeholder="-81.1769"
              inputMode="decimal"
            />
          </div>
        </div>

        <div className="row" style={{ gap: 12, marginTop: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Day brightness (%)</label>
            <input
              type="number"
              min={0}
              max={100}
              value={bForm.brightnessDay}
              onChange={(e) => setBForm({ ...bForm, brightnessDay: parseInt(e.target.value, 10) || 0 })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Night brightness (%)</label>
            <input
              type="number"
              min={0}
              max={100}
              value={bForm.brightnessNight}
              onChange={(e) => setBForm({ ...bForm, brightnessNight: parseInt(e.target.value, 10) || 0 })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Offset (min)</label>
            <input
              type="number"
              min={-120}
              max={120}
              value={bForm.brightnessOffsetMinutes}
              onChange={(e) => setBForm({ ...bForm, brightnessOffsetMinutes: parseInt(e.target.value, 10) || 0 })}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              + delays transitions, − anticipates. e.g. −30 dims 30 min before sunset.
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 12, background: 'var(--surface-2)', padding: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Today's transitions for this location</div>
          {sunPreview ? (
            <div className="row" style={{ gap: 24, fontSize: 14, flexWrap: 'wrap' }}>
              <div>
                ☀ Day brightness ({bForm.brightnessDay}%) starts at <strong>{formatTime(sunPreview.adjustedSunrise)}</strong>
                <span className="muted"> (sunrise {formatTime(sunPreview.sunrise)})</span>
              </div>
              <div>
                ☾ Night brightness ({bForm.brightnessNight}%) starts at <strong>{formatTime(sunPreview.adjustedSunset)}</strong>
                <span className="muted"> (sunset {formatTime(sunPreview.sunset)})</span>
              </div>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>
              Enter latitude and longitude to preview today's transitions.
            </div>
          )}
        </div>

        {device.last_applied_at && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Last applied: {device.last_applied_brightness}% at {new Date(device.last_applied_at).toLocaleString()}
          </div>
        )}

        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button disabled={busy} onClick={saveBrightnessForm}>
            Save automation
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Rental settings</h3>
          <label className="row" style={{ gap: 8, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={rForm.isRentable}
              onChange={(e) => setRForm({ ...rForm, isRentable: e.target.checked })}
              style={{ width: 'auto' }}
            />
            <span>Listed on /rent</span>
          </label>
        </div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          When enabled, this display appears on the public rental page where anyone can book ad space.
        </div>

        <div className="row" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Daily rate</label>
            <input
              value={rForm.dailyRate}
              onChange={(e) => setRForm({ ...rForm, dailyRate: e.target.value })}
              placeholder="50.00"
              inputMode="decimal"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Weekly rate</label>
            <input
              value={rForm.weeklyRate}
              onChange={(e) => setRForm({ ...rForm, weeklyRate: e.target.value })}
              placeholder="300.00"
              inputMode="decimal"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Monthly rate</label>
            <input
              value={rForm.monthlyRate}
              onChange={(e) => setRForm({ ...rForm, monthlyRate: e.target.value })}
              placeholder="1000.00"
              inputMode="decimal"
            />
          </div>
          <div style={{ width: 100 }}>
            <label>Currency</label>
            <input value={rForm.currency} onChange={(e) => setRForm({ ...rForm, currency: e.target.value.toUpperCase() })} maxLength={3} />
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Leave a rate empty to disable that duration. At least one rate is required when listed.
        </div>

        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button
            disabled={busy}
            onClick={() =>
              action(async () => {
                const updated = await devicesApi.update(device.id, {
                  isRentable: rForm.isRentable,
                  dailyRate: rForm.dailyRate.trim() === '' ? null : parseFloat(rForm.dailyRate),
                  weeklyRate: rForm.weeklyRate.trim() === '' ? null : parseFloat(rForm.weeklyRate),
                  monthlyRate: rForm.monthlyRate.trim() === '' ? null : parseFloat(rForm.monthlyRate),
                  rentalCurrency: rForm.currency || 'CAD',
                } as any);
                setDevice(updated);
                setRForm(deviceToRentalForm(updated));
              })
            }
          >
            Save rental settings
          </button>
        </div>
      </div>
    </div>
  );
}
