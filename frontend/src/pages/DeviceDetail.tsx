import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import SunCalc from 'suncalc';
import {
  devices as devicesApi,
  playlists as playlistsApi,
  clients as clientsApi,
  adContracts as adContractsApi,
  rentals as rentalsApi,
  type AdContract,
  type ClientHit,
  type UnattachedRental,
} from '../api/endpoints';
import type { AdminRental, Device, DeviceStatus, Playlist } from '../types';

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

interface SlotsFormState {
  maxAds: string;
  adSlotSeconds: string;
  basePlaylistId: string; // "" means none
}

function deviceToSlotsForm(d: Device): SlotsFormState {
  return {
    maxAds: String(d.max_ads ?? 8),
    adSlotSeconds: String(d.ad_slot_seconds ?? 6),
    basePlaylistId: d.base_playlist_id ?? '',
  };
}

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
interface OverlayFormState {
  clockEnabled: boolean;
  clockPosition: Corner;
  clockFormat: '12h' | '24h';
  weatherEnabled: boolean;
  weatherPosition: Corner;
  weatherLocation: string;
  weatherUnits: 'metric' | 'imperial';
}

function deviceToOverlayForm(d: Device): OverlayFormState {
  return {
    clockEnabled: d.overlay_clock_enabled ?? false,
    clockPosition: (d.overlay_clock_position as Corner) ?? 'top-right',
    clockFormat: d.overlay_clock_format ?? '12h',
    weatherEnabled: d.overlay_weather_enabled ?? false,
    weatherPosition: (d.overlay_weather_position as Corner) ?? 'top-left',
    weatherLocation: d.overlay_weather_location ?? '',
    weatherUnits: d.overlay_weather_units ?? 'metric',
  };
}

type Severity = 'minor' | 'moderate' | 'severe' | 'extreme';
interface AlertsFormState {
  enabled: boolean;
  severityMin: Severity;
}

function deviceToAlertsForm(d: Device): AlertsFormState {
  return {
    enabled: d.alerts_enabled ?? false,
    severityMin: ((d.alerts_severity_min as Severity) ?? 'severe'),
  };
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

interface MarketingFormState {
  description: string;
  trafficStat: string;
  photos: string[];      // photo URLs (server-hosted)
  photosText: string;    // newline-separated for the textarea editor
}

function deviceToMarketingForm(d: Device): MarketingFormState {
  const photos = d.photos ?? [];
  return {
    description: d.description ?? '',
    trafficStat: d.traffic_stat ?? '',
    photos,
    photosText: photos.join('\n'),
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
  // Separate from err so "VNNOX didn't return resolution" doesn't get the
  // red alarm treatment — it's an informational notice the admin should
  // act on, not an outright error.
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brightness, setBrightness] = useState(80);
  const [bForm, setBForm] = useState<BrightnessFormState | null>(null);
  const [rForm, setRForm] = useState<RentalFormState | null>(null);
  const [dForm, setDForm] = useState<DetailsFormState | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [mForm, setMForm] = useState<MarketingFormState | null>(null);
  const [sForm, setSForm] = useState<SlotsFormState | null>(null);
  const [oForm, setOForm] = useState<OverlayFormState | null>(null);
  const [aForm, setAForm] = useState<AlertsFormState | null>(null);
  const [orgPlaylists, setOrgPlaylists] = useState<Playlist[]>([]);
  // Owner client lookup + search ------------------------------------------
  const [ownerInfo, setOwnerInfo] = useState<ClientHit | null>(null);
  const [ownerQuery, setOwnerQuery] = useState('');
  const [ownerResults, setOwnerResults] = useState<ClientHit[]>([]);
  const [ownerSearching, setOwnerSearching] = useState(false);
  // Ad contracts on this device -------------------------------------------
  const [contracts, setContracts] = useState<AdContract[]>([]);
  const [contractsByClient, setContractsByClient] = useState<Record<number, ClientHit>>({});
  // "Add contract" modal --------------------------------------------------
  const [showAddContract, setShowAddContract] = useState(false);
  // Ad schedule (every rental on this device, sorted chronologically).
  const [schedule, setSchedule] = useState<AdminRental[]>([]);
  const [contractById, setContractById] = useState<Record<string, AdContract>>({});

  useEffect(() => {
    if (!id) return;
    devicesApi
      .get(id)
      .then((d) => {
        setDevice(d);
        setBForm(deviceToBrightnessForm(d));
        setRForm(deviceToRentalForm(d));
        setDForm(deviceToDetailsForm(d));
        setMForm(deviceToMarketingForm(d));
        setSForm(deviceToSlotsForm(d));
        setOForm(deviceToOverlayForm(d));
        setAForm(deviceToAlertsForm(d));
      })
      .catch((e) => setErr((e as Error).message));
    // Playlists for the base-rotation picker. Best-effort: if it fails, the
    // dropdown just shows "(none)".
    playlistsApi.list().then(setOrgPlaylists).catch(() => undefined);
    // Ad contracts on this device.
    adContractsApi.list({ deviceId: id }).then(setContracts).catch(() => undefined);
    // Every rental on this device for the schedule timeline. Pull a
    // generous limit so we can show past + upcoming in one view.
    rentalsApi.list({ deviceId: id, limit: 500 }).then(setSchedule).catch(() => undefined);
  }, [id]);

  // Build a contract_id → AdContract lookup so the schedule rows can
  // resolve the client_id (and from there, the company name) without an
  // extra round-trip per rental.
  useEffect(() => {
    const map: Record<string, AdContract> = {};
    for (const c of contracts) map[c.id] = c;
    setContractById(map);
  }, [contracts]);

  // Look up the owner client's display name whenever device.owner_client_id changes.
  useEffect(() => {
    if (!device || device.owner_client_id == null) {
      setOwnerInfo(null);
      return;
    }
    let cancelled = false;
    clientsApi.get(device.owner_client_id)
      .then((c) => {
        if (!cancelled) setOwnerInfo({ id: c.id, name: c.name, email: c.email, company: c.company });
      })
      .catch(() => {
        if (!cancelled) setOwnerInfo(null);
      });
    return () => { cancelled = true; };
  }, [device]);

  // Bulk-lookup display names for the clients referenced by contracts.
  // Single-flight per id, cached across re-fetches of the contracts list.
  useEffect(() => {
    const ids = Array.from(new Set(contracts.map((c) => c.client_id)));
    const missing = ids.filter((cid) => !contractsByClient[cid]);
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.allSettled(missing.map((cid) => clientsApi.get(cid))).then((results) => {
      if (cancelled) return;
      setContractsByClient((prev) => {
        const next = { ...prev };
        for (let i = 0; i < results.length; i++) {
          const cid = missing[i];
          const r = results[i];
          if (r.status === 'fulfilled') {
            next[cid] = { id: r.value.id, name: r.value.name, email: r.value.email, company: r.value.company };
          } else {
            next[cid] = { id: cid, email: null, company: null, name: `Client #${cid}` };
          }
        }
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [contracts, contractsByClient]);

  // Debounced client search for the owner picker.
  useEffect(() => {
    const q = ownerQuery.trim();
    if (q.length < 2) {
      setOwnerResults([]);
      return;
    }
    setOwnerSearching(true);
    const t = setTimeout(() => {
      clientsApi
        .search(q)
        .then((r) => setOwnerResults(r.clients))
        .catch(() => setOwnerResults([]))
        .finally(() => setOwnerSearching(false));
    }, 350);
    return () => clearTimeout(t);
  }, [ownerQuery]);

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

  if (!device || !bForm || !rForm || !dForm || !mForm || !sForm || !oForm) return <div>{err ? <div className="error-banner">{err}</div> : 'Loading…'}</div>;

  // On the device page we want the company name front-and-centre rather
  // than the contact's personal name, because the device-level relationship
  // is with the business, not the individual contact. Falls back to the
  // computed display name (fname+lname or email) when company is blank.
  const clientLabel = (c: ClientHit | undefined, id: number): string => {
    if (!c) return `Client #${id}`;
    return c.company || c.name || `Client #${id}`;
  };

  // pg-node hands DATE columns back as ISO timestamps; cut to YYYY-MM-DD
  // for display and date-input round-tripping.
  const toDate = (s: string | null | undefined): string => (s ? s.slice(0, 10) : '');

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
      {notice && (
        <div style={{
          background: '#fef3c7',
          color: '#92400e',
          border: '1px solid #fde68a',
          borderRadius: 6,
          padding: '8px 12px',
          fontSize: 13,
        }}>
          {notice}
        </div>
      )}

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
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span><span className="muted">Resolution:</span> {device.width_px && device.height_px ? `${device.width_px} × ${device.height_px}` : '—'}</span>
                {device.provider === 'vnnox' && (
                  <button
                    onClick={() =>
                      action(async () => {
                        const r = await devicesApi.pullInfo(device.id);
                        setDevice(r.device);
                        setDForm(deviceToDetailsForm(r.device));
                        if (r.notice) {
                          // Informational: VNNOX didn't expose geometry.
                          // Goes to the yellow notice banner, not the red
                          // error banner. Clear any pre-existing real error.
                          setNotice(r.notice);
                          setErr(null);
                        } else if (r.pulled.widthPx && r.pulled.heightPx) {
                          setErr(null);
                          setNotice(null);
                        }
                      })
                    }
                    disabled={busy}
                    style={{ fontSize: 12, padding: '2px 8px' }}
                    title="Force-refresh resolution from VNNOX"
                  >
                    Pull from VNNOX
                  </button>
                )}
              </div>
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

      {/* --- Screen ownership card -------------------------------------- */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Screen owner</h3>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Set a screen-owner client if the screen belongs to a customer (e.g. they
          bought it from us). An <em>owner_perpetual</em> ad contract is auto-created
          so all their ads flow through the same contracts → ads pipeline. Leave
          unset for Holm-owned rental screens.
        </div>
        {device.owner_client_id != null ? (
          <div className="row between" style={{ alignItems: 'center' }}>
            <div>
              <strong>
                {clientLabel(
                  contractsByClient[device.owner_client_id] ?? ownerInfo ?? undefined,
                  device.owner_client_id,
                )}
              </strong>
              <div className="muted" style={{ fontSize: 12 }}>
                shop-api client id: {device.owner_client_id}
              </div>
            </div>
            <button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  if (!confirm('Clear screen ownership? The owner_perpetual contract stays for history.')) return;
                  const updated = await devicesApi.update(device.id, {
                    ownerClientId: null,
                    ownerProjectId: null,
                  } as any);
                  setDevice(updated);
                })
              }
            >
              Clear owner
            </button>
          </div>
        ) : (
          <div>
            <input
              placeholder="Search clients by company, email, or name…"
              value={ownerQuery}
              onChange={(e) => setOwnerQuery(e.target.value)}
            />
            {ownerSearching && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Searching…</div>}
            {ownerResults.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, marginTop: 8, border: '1px solid #ddd', borderRadius: 4, maxHeight: 220, overflowY: 'auto' }}>
                {ownerResults.map((c) => (
                  <li key={c.id} style={{ padding: '8px 12px', borderBottom: '1px solid #eee' }}>
                    <div className="row between" style={{ alignItems: 'center' }}>
                      <div>
                        <strong>{c.name}</strong>
                        {c.company && c.company !== c.name && (
                          <div className="muted" style={{ fontSize: 12 }}>{c.company}</div>
                        )}
                        {c.email && <div className="muted" style={{ fontSize: 12 }}>{c.email}</div>}
                      </div>
                      <button
                        disabled={busy}
                        onClick={() =>
                          action(async () => {
                            const updated = await devicesApi.update(device.id, {
                              ownerClientId: c.id,
                            } as any);
                            setDevice(updated);
                            setOwnerQuery('');
                            setOwnerResults([]);
                            // Refresh contracts so the auto-created owner_perpetual shows up.
                            const fresh = await adContractsApi.list({ deviceId: device.id });
                            setContracts(fresh);
                          })
                        }
                      >
                        Set as owner
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {ownerQuery.trim().length >= 2 && !ownerSearching && ownerResults.length === 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>No matches.</div>
            )}
          </div>
        )}
      </div>

      {/* --- Ad contracts on this device --------------------------------- */}
      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Ad contracts</h3>
          <button disabled={busy} onClick={() => setShowAddContract(true)}>
            + Add contract
          </button>
        </div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          The commercial agreement between a client and this screen. One client
          can have multiple ads (creatives) under a single contract.
        </div>
        {contracts.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No contracts yet.</div>
        ) : (
          <table style={{ width: '100%', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                <th>Client</th>
                <th>Type</th>
                <th>Term</th>
                <th>Status</th>
                <th>Auto-renew</th>
                <th>Ads</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td>
                    {clientLabel(contractsByClient[c.client_id], c.client_id)}
                  </td>
                  <td>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {c.contract_type === 'owner_perpetual' ? 'owner' : 'rental'}
                    </span>
                  </td>
                  <td>
                    {c.contract_type === 'owner_perpetual'
                      ? <span className="muted">perpetual</span>
                      : `${toDate(c.start_date)} → ${toDate(c.end_date) || '?'}`}
                  </td>
                  <td>
                    <span style={{
                      fontSize: 12,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: c.status === 'active' ? '#dcfce7' : c.status === 'expired' ? '#fef3c7' : '#fee2e2',
                    }}>
                      {c.status}
                    </span>
                  </td>
                  <td>{c.contract_type === 'owner_perpetual' ? '—' : (c.auto_renew ? '✓' : '—')}</td>
                  <td>{c.rental_count ?? 0}</td>
                  <td>
                    <Link to={`/ad-contracts/${c.id}`} style={{ fontSize: 13 }}>Open →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- Ad schedule (every rental on this device, by start date) --- */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Ad schedule</h3>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          All ads scheduled or running on this screen, ordered by start date.
          Edit individual run windows from each ad's contract page.
        </div>
        {schedule.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            No ads scheduled. Use "Add ad contract" above to attribute existing ads.
          </div>
        ) : (
          (() => {
            const today = new Date().toISOString().slice(0, 10);
            const sorted = [...schedule].sort((a, b) => {
              const ad = a.start_date ?? '9999';
              const bd = b.start_date ?? '9999';
              return ad < bd ? -1 : ad > bd ? 1 : 0;
            });
            return (
              <table style={{ width: '100%', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                    <th>Status</th>
                    <th>Company</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Daypart</th>
                    <th>Artwork</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => {
                    const contract = r.contract_id ? contractById[r.contract_id] : null;
                    const client = contract ? contractsByClient[contract.client_id] : null;
                    const company = client?.company || client?.name || (r.advertiser_business || r.advertiser_name);
                    const isFuture = r.start_date != null && toDate(r.start_date) > today;
                    const isPast   = r.end_date != null && toDate(r.end_date) < today;
                    const dotColor = r.status === 'active' ? '#16a34a'
                                   : isFuture                ? '#2563eb'
                                   : isPast                  ? '#9ca3af'
                                   :                            '#f59e0b';
                    return (
                      <tr key={r.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td>
                          <span
                            title={r.status}
                            style={{
                              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                              background: dotColor, marginRight: 6,
                            }}
                          />
                          <span className="muted" style={{ fontSize: 12 }}>{r.status}</span>
                        </td>
                        <td>
                          {contract ? (
                            <Link to={`/ad-contracts/${contract.id}`}>{company}</Link>
                          ) : (
                            <span>{company} <span className="muted" style={{ fontSize: 11 }}>(unattributed)</span></span>
                          )}
                        </td>
                        <td>{r.start_date ? toDate(r.start_date) : <span className="muted">—</span>}</td>
                        <td>{r.end_date   ? toDate(r.end_date)   : <span className="muted">—</span>}</td>
                        <td>{r.start_time?.slice(0, 5)}–{r.end_time?.slice(0, 5)}</td>
                        <td>
                          {r.artwork_url && r.artwork_mime?.startsWith('image/') ? (
                            <img
                              src={r.artwork_url}
                              alt=""
                              style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4, border: '1px solid #ddd' }}
                            />
                          ) : r.artwork_url ? (
                            <a href={r.artwork_url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>file</a>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {contract && (
                            <Link to={`/ad-contracts/${contract.id}`} style={{ fontSize: 13 }}>Edit →</Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          })()
        )}
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#16a34a' }} /> active
          {' · '}
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#2563eb' }} /> upcoming
          {' · '}
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#f59e0b' }} /> pending review/payment
          {' · '}
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#9ca3af' }} /> past
        </div>
      </div>

      {/* --- New-contract modal ----------------------------------------- */}
      {showAddContract && (
        <NewContractModal
          deviceId={device.id}
          onClose={() => setShowAddContract(false)}
          onCreated={async () => {
            setShowAddContract(false);
            const fresh = await adContractsApi.list({ deviceId: device.id });
            setContracts(fresh);
          }}
        />
      )}

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

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Ad slot rotation</h3>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Each customer ad gets one slot in the rotation. All active ads play in series
          alongside the base playlist (the regular rotation that runs between ads).
        </div>

        <div className="row" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Max concurrent ads</label>
            <input
              value={sForm.maxAds}
              onChange={(e) => setSForm({ ...sForm, maxAds: e.target.value })}
              placeholder="8"
              inputMode="numeric"
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Bookings beyond this are refused at approval. 0–64.
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label>Slot length (seconds)</label>
            <input
              value={sForm.adSlotSeconds}
              onChange={(e) => setSForm({ ...sForm, adSlotSeconds: e.target.value })}
              placeholder="6"
              inputMode="numeric"
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              How long each ad plays per rotation pass. Shown to customers as "buy a {sForm.adSlotSeconds}s slot".
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <label>Base content playlist</label>
          <select
            value={sForm.basePlaylistId}
            onChange={(e) => setSForm({ ...sForm, basePlaylistId: e.target.value })}
          >
            <option value="">(none — ads only)</option>
            {orgPlaylists.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Plays between ads. Pick the playlist you'd normally run on this screen.
          </div>
        </div>

        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button
            disabled={busy}
            onClick={() =>
              action(async () => {
                const maxAds = parseInt(sForm.maxAds, 10);
                const adSlotSeconds = parseInt(sForm.adSlotSeconds, 10);
                if (!Number.isFinite(maxAds) || maxAds < 0 || maxAds > 64) {
                  throw new Error('Max ads must be between 0 and 64.');
                }
                if (!Number.isFinite(adSlotSeconds) || adSlotSeconds < 1 || adSlotSeconds > 60) {
                  throw new Error('Slot length must be between 1 and 60 seconds.');
                }
                const updated = await devicesApi.update(device.id, {
                  maxAds,
                  adSlotSeconds,
                  basePlaylistId: sForm.basePlaylistId || null,
                } as any);
                setDevice(updated);
                setSForm(deviceToSlotsForm(updated));
              })
            }
          >
            Save ad slot config
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Overlay widgets</h3>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Live clock and weather widgets layered over the base playlist (and visible
          alongside running ads). Pick a corner so they don't clash with your ad layouts.
        </div>

        {/* Clock */}
        <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 16 }}>
          <label className="row" style={{ gap: 8, fontSize: 14, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={oForm.clockEnabled}
              onChange={(e) => setOForm({ ...oForm, clockEnabled: e.target.checked })}
              style={{ width: 'auto' }}
            />
            <span><strong>Clock</strong> — show current time</span>
          </label>
          {oForm.clockEnabled && (
            <div className="row" style={{ gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label>Position</label>
                <select
                  value={oForm.clockPosition}
                  onChange={(e) => setOForm({ ...oForm, clockPosition: e.target.value as Corner })}
                >
                  <option value="top-left">Top-left</option>
                  <option value="top-right">Top-right</option>
                  <option value="bottom-left">Bottom-left</option>
                  <option value="bottom-right">Bottom-right</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label>Format</label>
                <select
                  value={oForm.clockFormat}
                  onChange={(e) => setOForm({ ...oForm, clockFormat: e.target.value as '12h' | '24h' })}
                >
                  <option value="12h">12-hour (3:45 PM)</option>
                  <option value="24h">24-hour (15:45)</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Weather */}
        <div style={{ marginBottom: 12 }}>
          <label className="row" style={{ gap: 8, fontSize: 14, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={oForm.weatherEnabled}
              onChange={(e) => setOForm({ ...oForm, weatherEnabled: e.target.checked })}
              style={{ width: 'auto' }}
            />
            <span><strong>Weather</strong> — current conditions + temperature</span>
          </label>
          {oForm.weatherEnabled && (
            <>
              <div className="row" style={{ gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label>Position</label>
                  <select
                    value={oForm.weatherPosition}
                    onChange={(e) => setOForm({ ...oForm, weatherPosition: e.target.value as Corner })}
                  >
                    <option value="top-left">Top-left</option>
                    <option value="top-right">Top-right</option>
                    <option value="bottom-left">Bottom-left</option>
                    <option value="bottom-right">Bottom-right</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label>Units</label>
                  <select
                    value={oForm.weatherUnits}
                    onChange={(e) => setOForm({ ...oForm, weatherUnits: e.target.value as 'metric' | 'imperial' })}
                  >
                    <option value="metric">Metric (°C)</option>
                    <option value="imperial">Imperial (°F)</option>
                  </select>
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <label>Location</label>
                <input
                  value={oForm.weatherLocation}
                  onChange={(e) => setOForm({ ...oForm, weatherLocation: e.target.value })}
                  placeholder='City name (e.g. "Listowel, ON") or "lat,lng"'
                />
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Falls back to the device's lat/lng (set in the brightness card) when blank.
                </div>
              </div>
            </>
          )}
        </div>

        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
          <button
            disabled={busy}
            onClick={() =>
              action(async () => {
                if (oForm.weatherEnabled && !oForm.weatherLocation.trim() && (!device.latitude || !device.longitude)) {
                  throw new Error('Weather needs either a location or lat/lng on the device.');
                }
                const updated = await devicesApi.update(device.id, {
                  overlayClockEnabled: oForm.clockEnabled,
                  overlayClockPosition: oForm.clockPosition,
                  overlayClockFormat: oForm.clockFormat,
                  overlayWeatherEnabled: oForm.weatherEnabled,
                  overlayWeatherPosition: oForm.weatherPosition,
                  overlayWeatherLocation: oForm.weatherLocation.trim() || null,
                  overlayWeatherUnits: oForm.weatherUnits,
                } as any);
                setDevice(updated);
                setOForm(deviceToOverlayForm(updated));
              })
            }
          >
            Save overlay widgets
          </button>
          <button
            disabled={busy}
            onClick={() => action(() => devicesApi.republishBase(device.id))}
            title="Re-publish the base program with the current overlay widget settings."
          >
            Apply to device
          </button>
        </div>
      </div>

      {aForm && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Public safety alerts</h3>
          <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            When enabled, this device shows a scrolling banner along the bottom
            during active Environment Canada alerts that cover this location.
            Uses the device's lat/lng. Updates within 5 minutes of an alert
            being issued or cleared.
          </div>

          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              id="alerts-enabled"
              checked={aForm.enabled}
              onChange={(e) => setAForm({ ...aForm, enabled: e.target.checked })}
            />
            <label htmlFor="alerts-enabled" style={{ marginBottom: 0 }}>
              Show Environment Canada alerts on this screen
            </label>
          </div>

          {aForm.enabled && (
            <div style={{ marginTop: 12, maxWidth: 360 }}>
              <label>Minimum severity to display</label>
              <select
                value={aForm.severityMin}
                onChange={(e) =>
                  setAForm({ ...aForm, severityMin: e.target.value as Severity })
                }
              >
                <option value="extreme">Extreme only (e.g. tornado warning)</option>
                <option value="severe">Severe + above (warnings — recommended)</option>
                <option value="moderate">Moderate + above (watches included)</option>
                <option value="minor">Everything (advisories, special statements)</option>
              </select>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                "Severe" is the sensible default — surfaces tornado, blizzard,
                and other actual-impact warnings while suppressing routine
                special weather statements.
              </div>
            </div>
          )}

          {device.alerts_current_text && (
            <div
              style={{
                marginTop: 12,
                padding: 8,
                background: 'rgba(245, 158, 11, 0.1)',
                border: '1px solid #f59e0b',
                borderRadius: 4,
                fontSize: 13,
              }}
            >
              <strong>Currently showing:</strong> {device.alerts_current_text}
            </div>
          )}
          {!device.alerts_current_text && aForm.enabled && (
            <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
              No active alerts for this location right now.
              {device.alerts_last_polled_at && (
                <> Last checked {new Date(device.alerts_last_polled_at).toLocaleString()}.</>
              )}
            </div>
          )}
          {(!device.latitude || !device.longitude) && aForm.enabled && (
            <div className="error-banner" style={{ marginTop: 12 }}>
              This device has no lat/lng set (in the brightness card above), so
              alerts can't be matched. Set the coordinates first.
            </div>
          )}

          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
            <button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  const updated = await devicesApi.update(device.id, {
                    alertsEnabled: aForm.enabled,
                    alertsSeverityMin: aForm.severityMin,
                  } as unknown as Parameters<typeof devicesApi.update>[1]);
                  setDevice(updated);
                  setAForm(deviceToAlertsForm(updated));
                })
              }
            >
              Save alerts settings
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Marketing (public /advertise listing)</h3>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          These show on holmgraphics.ca/advertise so prospects can pick a display.
          Leave blank if you don't want the field shown.
        </div>

        <div>
          <label>Description</label>
          <textarea
            rows={3}
            value={mForm.description}
            onChange={(e) => setMForm({ ...mForm, description: e.target.value })}
            placeholder="One-paragraph blurb about this location and audience."
          />
        </div>

        <div style={{ marginTop: 8 }}>
          <label>Traffic / reach stat</label>
          <input
            value={mForm.trafficStat}
            onChange={(e) => setMForm({ ...mForm, trafficStat: e.target.value })}
            placeholder="Seen by ~50,000 vehicles/week"
          />
        </div>

        <div style={{ marginTop: 8 }}>
          <label>Photo URLs (one per line)</label>
          <textarea
            rows={3}
            value={mForm.photosText}
            onChange={(e) => setMForm({ ...mForm, photosText: e.target.value })}
            placeholder="https://holmgraphics.ca/Images/LED_Sign_HHWalkerton.jpg"
          />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Paste full HTTPS URLs to existing photos (holmgraphics.ca/Images/... etc).
            The first image is the hero shown on the listing page.
          </div>
        </div>

        {mForm.photos.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {mForm.photos.map((url, i) => (
              <img
                key={i}
                src={url}
                alt=""
                style={{ width: 120, height: 90, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }}
              />
            ))}
          </div>
        )}

        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button
            disabled={busy}
            onClick={() =>
              action(async () => {
                const photos = mForm.photosText
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean);
                const updated = await devicesApi.update(device.id, {
                  description: mForm.description.trim() || null,
                  trafficStat: mForm.trafficStat.trim() || null,
                  photos,
                } as any);
                setDevice(updated);
                setMForm(deviceToMarketingForm(updated));
              })
            }
          >
            Save marketing
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── NewContractModal ───────────────────────────────────────────────────────
//
// Lightweight inline-modal for creating an ad contract on a device. Lets
// the admin pick a client (via the shop-api search proxy), set term and
// price, and optionally attribute an already-existing rental on this
// device to the new contract in one shot.

function NewContractModal({
  deviceId,
  onClose,
  onCreated,
}: {
  deviceId: string;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ClientHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<ClientHit | null>(null);
  const [startDate, setStartDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState<string>('');
  const [termCount, setTermCount] = useState<string>('12');
  const [termUnit, setTermUnit] = useState<'day' | 'week' | 'month' | 'year'>('month');
  const [amountDollars, setAmountDollars] = useState<string>('');
  const [autoRenew, setAutoRenew] = useState(false);
  const [billingEmail, setBillingEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Existing ads on this screen that haven't been attributed to any contract.
  const [available, setAvailable] = useState<UnattachedRental[]>([]);
  const [attachIds, setAttachIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      clientsApi
        .search(q)
        .then((r) => setResults(r.clients))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  // Pull the list of unattached rentals on this device when the modal opens.
  useEffect(() => {
    adContractsApi.unattachedRentals(deviceId).then(setAvailable).catch(() => setAvailable([]));
  }, [deviceId]);

  const toggleAttach = (id: string) => {
    setAttachIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!picked) {
      setError('Pick a client first.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const amountCents = amountDollars.trim() === '' ? undefined : Math.round(parseFloat(amountDollars) * 100);
      await adContractsApi.create({
        clientId:           picked.id,
        deviceId,
        contractType:       'rental',
        startDate:          startDate || undefined,
        endDate:            endDate || undefined,
        termCount:          termCount.trim() === '' ? undefined : parseInt(termCount, 10),
        termUnit,
        amountCents,
        autoRenew,
        billingContactEmail: billingEmail.trim() || undefined,
        notes:              notes.trim() || undefined,
        attachRentalIds:    attachIds.size > 0 ? Array.from(attachIds) : undefined,
      });
      await onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ maxWidth: 560, width: '90%', maxHeight: '90vh', overflowY: 'auto', background: 'white' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row between" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>New ad contract</h3>
          <button onClick={onClose}>✕</button>
        </div>

        {error && <div className="error-banner" style={{ marginBottom: 8 }}>{error}</div>}

        <label>Client</label>
        {picked ? (
          <div className="row between" style={{ alignItems: 'center', padding: '6px 0' }}>
            <div>
              <strong>{picked.name}</strong>
              {picked.email && <div className="muted" style={{ fontSize: 12 }}>{picked.email}</div>}
            </div>
            <button onClick={() => { setPicked(null); setQ(''); }}>Change</button>
          </div>
        ) : (
          <>
            <input
              placeholder="Search by company, email, or name…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {searching && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Searching…</div>}
            {results.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, marginTop: 8, border: '1px solid #ddd', borderRadius: 4, maxHeight: 200, overflowY: 'auto' }}>
                {results.map((c) => (
                  <li
                    key={c.id}
                    style={{ padding: '6px 10px', borderBottom: '1px solid #eee', cursor: 'pointer' }}
                    onClick={() => setPicked(c)}
                  >
                    <strong>{c.name}</strong>
                    {c.email && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{c.email}</span>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="row" style={{ gap: 12, marginTop: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Start date</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label>End date</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>

        <div className="row" style={{ gap: 12, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label>Term count</label>
            <input value={termCount} onChange={(e) => setTermCount(e.target.value)} inputMode="numeric" />
          </div>
          <div style={{ flex: 1 }}>
            <label>Term unit</label>
            <select value={termUnit} onChange={(e) => setTermUnit(e.target.value as 'day' | 'week' | 'month' | 'year')}>
              <option value="day">day</option>
              <option value="week">week</option>
              <option value="month">month</option>
              <option value="year">year</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>Amount ($)</label>
            <input value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} inputMode="decimal" placeholder="1200" />
          </div>
        </div>

        <div style={{ marginTop: 8 }}>
          <label>Billing contact email (optional)</label>
          <input value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} placeholder="accounts@client.com" />
        </div>

        <div style={{ marginTop: 8 }}>
          <label>Notes</label>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <label className="row" style={{ gap: 8, marginTop: 8, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={autoRenew}
            onChange={(e) => setAutoRenew(e.target.checked)}
            style={{ width: 'auto' }}
          />
          <span>Auto-renew (mints a QBO invoice 30 days before end date — DORMANT until master switch is flipped)</span>
        </label>

        {/* --- Attribute existing ads --- */}
        {available.length > 0 && (
          <div style={{ marginTop: 16, padding: 12, border: '1px solid #ddd', borderRadius: 4, background: '#f9fafb' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Attribute existing ads on this screen</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              Tick any ads already running on this screen that belong to this contract.
              They'll be linked to the contract on save.
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 220, overflowY: 'auto' }}>
              {available.map((r) => (
                <li key={r.id} style={{ padding: '6px 0', borderBottom: '1px solid #eee' }}>
                  <label className="row" style={{ gap: 10, alignItems: 'center', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={attachIds.has(r.id)}
                      onChange={() => toggleAttach(r.id)}
                      style={{ width: 'auto' }}
                    />
                    {r.artwork_url && r.artwork_mime?.startsWith('image/') && (
                      <img
                        src={r.artwork_url}
                        alt=""
                        style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4, border: '1px solid #ddd' }}
                      />
                    )}
                    <div style={{ flex: 1, fontSize: 13 }}>
                      <div><strong>{r.advertiser_name}</strong> {r.advertiser_business && <span className="muted">({r.advertiser_business})</span>}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {r.start_date && r.end_date ? `${r.start_date} → ${r.end_date}` : <em>unscheduled</em>}
                        {' · '}
                        {r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}
                        {' · '}
                        ${(r.amount_cents / 100).toFixed(2)} {r.currency}
                        {' · '}
                        <span style={{ fontStyle: 'italic' }}>{r.status}</span>
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} disabled={saving}>Cancel</button>
          <button onClick={submit} disabled={saving || !picked}>
            {saving ? 'Saving…' : attachIds.size > 0 ? `Create + attach ${attachIds.size} ad${attachIds.size === 1 ? '' : 's'}` : 'Create contract'}
          </button>
        </div>
      </div>
    </div>
  );
}
