import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { devices as devicesApi, media as mediaApi, playlists as playlistsApi } from '../api/endpoints';
import { ThumbnailStrip } from '../components/Thumbnail';
import type { Device, Media, Playlist } from '../types';

export default function Playlists() {
  const [list, setList] = useState<Playlist[]>([]);
  const [mediaList, setMediaList] = useState<Media[]>([]);
  const [deviceList, setDeviceList] = useState<Device[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  // Deploy modal state
  const [deployFor, setDeployFor] = useState<Playlist | null>(null);
  const [deployDeviceId, setDeployDeviceId] = useState<string>('');
  const [deploying, setDeploying] = useState(false);

  const refresh = () =>
    Promise.all([playlistsApi.list(), mediaApi.list(), devicesApi.list()])
      .then(([p, m, d]) => {
        setList(p);
        setMediaList(m);
        setDeviceList(d);
      })
      .catch((e) => setErr((e as Error).message));

  useEffect(() => {
    refresh();
  }, []);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await playlistsApi.create({
        name,
        // 6s default matches the ad-slot length convention so new playlists
        // feel consistent with how rental ads play in the rotation.
        items: picked.map((mediaId) => ({ mediaId, durationMs: 6000 })),
      });
      setName('');
      setPicked([]);
      refresh();
    } catch (ex) {
      setErr((ex as Error).message);
    }
  };

  const openDeploy = (p: Playlist) => {
    if (deviceList.length === 0) {
      setErr('Register a device first.');
      return;
    }
    setDeployFor(p);
    setDeployDeviceId(deviceList[0].id);
    setErr(null);
    setInfo(null);
  };

  const confirmDeploy = async () => {
    if (!deployFor || !deployDeviceId) return;
    setDeploying(true);
    setErr(null);
    try {
      await playlistsApi.deploy(deployFor.id, deployDeviceId);
      const dev = deviceList.find((d) => d.id === deployDeviceId);
      setInfo(`Deployed "${deployFor.name}" to ${dev?.name ?? 'device'}.`);
      setDeployFor(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDeploying(false);
    }
  };

  const onDelete = async (p: Playlist) => {
    if (!confirm(`Delete playlist "${p.name}"? Media files are not affected.`)) return;
    try {
      await playlistsApi.remove(p.id);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Playlists</h1>
      {err && <div className="error-banner">{err}</div>}
      {info && (
        <div className="card" style={{ background: 'rgba(63,191,111,0.15)', color: 'var(--green)' }}>
          {info}
        </div>
      )}

      <form onSubmit={onCreate} className="card stack">
        <h3 style={{ marginTop: 0 }}>New playlist</h3>
        <div>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label>Media items (click to toggle, order = click order)</label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {mediaList.map((m) => {
              const idx = picked.indexOf(m.id);
              return (
                <button
                  type="button"
                  key={m.id}
                  className={idx >= 0 ? '' : 'secondary'}
                  onClick={() =>
                    setPicked(idx >= 0 ? picked.filter((x) => x !== m.id) : [...picked, m.id])
                  }
                >
                  {idx >= 0 ? `${idx + 1}. ` : ''}{m.original_name}
                </button>
              );
            })}
            {mediaList.length === 0 && <span className="muted">Upload media first.</span>}
          </div>
        </div>
        <button type="submit" disabled={!name || picked.length === 0}>Create</button>
      </form>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Preview</th>
              <th>Loop</th>
              <th>Updated</th>
              <th style={{ width: 260 }}></th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/playlists/${p.id}`}>{p.name}</Link>
                </td>
                <td>
                  <ThumbnailStrip items={p.thumbnails ?? []} size={48} max={4} />
                </td>
                <td>{p.loop ? 'yes' : 'no'}</td>
                <td className="muted">{new Date(p.updated_at).toLocaleString()}</td>
                <td>
                  <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    <Link to={`/playlists/${p.id}`}>
                      <button className="secondary">Edit</button>
                    </Link>
                    <button onClick={() => openDeploy(p)}>Deploy →</button>
                    <button className="danger" onClick={() => onDelete(p)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No playlists yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {deployFor && (
        <div
          onClick={() => setDeployFor(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{ width: 420, maxWidth: '90vw' }}
          >
            <h3 style={{ marginTop: 0 }}>Deploy "{deployFor.name}"</h3>
            <div>
              <label>Display</label>
              <select
                value={deployDeviceId}
                onChange={(e) => setDeployDeviceId(e.target.value)}
              >
                {deviceList.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}{d.location ? ` — ${d.location}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end', gap: 8 }}>
              <button className="secondary" onClick={() => setDeployFor(null)} disabled={deploying}>
                Cancel
              </button>
              <button onClick={confirmDeploy} disabled={deploying}>
                {deploying ? 'Deploying…' : 'Deploy'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
