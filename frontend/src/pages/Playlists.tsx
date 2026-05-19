import { FormEvent, useEffect, useState } from 'react';
import { devices as devicesApi, media as mediaApi, playlists as playlistsApi } from '../api/endpoints';
import type { Device, Media, Playlist } from '../types';

export default function Playlists() {
  const [list, setList] = useState<Playlist[]>([]);
  const [mediaList, setMediaList] = useState<Media[]>([]);
  const [deviceList, setDeviceList] = useState<Device[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

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
        items: picked.map((mediaId) => ({ mediaId, durationMs: 10000 })),
      });
      setName('');
      setPicked([]);
      refresh();
    } catch (ex) {
      setErr((ex as Error).message);
    }
  };

  const onDeploy = async (playlistId: string) => {
    if (deviceList.length === 0) {
      setErr('Register a device first.');
      return;
    }
    const deviceId = prompt(
      'Deploy to which device?\n\n' + deviceList.map((d) => `${d.id} — ${d.name}`).join('\n'),
      deviceList[0].id,
    );
    if (!deviceId) return;
    try {
      await playlistsApi.deploy(playlistId, deviceId);
      alert('Deployed.');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Playlists</h1>
      {err && <div className="error-banner">{err}</div>}

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
              <th>Loop</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.loop ? 'yes' : 'no'}</td>
                <td className="muted">{new Date(p.updated_at).toLocaleString()}</td>
                <td>
                  <button onClick={() => onDeploy(p.id)}>Deploy →</button>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No playlists yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
