import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { devices as devicesApi, media as mediaApi, playlists as playlistsApi } from '../api/endpoints';
import { Thumbnail } from '../components/Thumbnail';
import type { Device, Media, Playlist, PlaylistItem } from '../types';

interface EditableItem {
  mediaId: string;
  durationMs: number;
}

function playlistToItems(p: Playlist): EditableItem[] {
  return (p.items ?? []).slice().sort((a, b) => a.position - b.position).map((it: PlaylistItem) => ({
    mediaId: it.media_id,
    durationMs: it.duration_ms,
  }));
}

export default function PlaylistDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [mediaList, setMediaList] = useState<Media[]>([]);
  const [deviceList, setDeviceList] = useState<Device[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // editable state
  const [name, setName] = useState('');
  const [loop, setLoop] = useState(true);
  const [items, setItems] = useState<EditableItem[]>([]);

  // deploy modal
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployDeviceId, setDeployDeviceId] = useState('');
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([playlistsApi.get(id), mediaApi.list(), devicesApi.list()])
      .then(([p, m, d]) => {
        setPlaylist(p);
        setMediaList(m);
        setDeviceList(d);
        setName(p.name);
        setLoop(p.loop);
        setItems(playlistToItems(p));
      })
      .catch((e) => setErr((e as Error).message));
  }, [id]);

  const mediaById = useMemo(() => {
    const m = new Map<string, Media>();
    mediaList.forEach((x) => m.set(x.id, x));
    return m;
  }, [mediaList]);

  if (!playlist) {
    return (
      <div>
        <Link to="/playlists" className="muted">← All playlists</Link>
        {err ? <div className="error-banner">{err}</div> : <div className="muted">Loading…</div>}
      </div>
    );
  }

  const move = (idx: number, delta: number) => {
    const next = items.slice();
    const j = idx + delta;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setItems(next);
  };

  const remove = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  const addItem = (mediaId: string) => {
    if (items.some((it) => it.mediaId === mediaId)) {
      // toggle off
      setItems(items.filter((it) => it.mediaId !== mediaId));
    } else {
      setItems([...items, { mediaId, durationMs: 6000 }]);
    }
  };

  const setDuration = (idx: number, ms: number) => {
    const next = items.slice();
    next[idx] = { ...next[idx], durationMs: ms };
    setItems(next);
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const updated = await playlistsApi.update(playlist.id, {
        name,
        loop,
        items: items.map((it) => ({ mediaId: it.mediaId, durationMs: it.durationMs })),
      });
      setPlaylist(updated);
      const reloaded = await playlistsApi.get(playlist.id);
      setPlaylist(reloaded);
      setItems(playlistToItems(reloaded));
      setInfo('Saved.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!confirm(`Delete playlist "${playlist.name}"?`)) return;
    setBusy(true);
    try {
      await playlistsApi.remove(playlist.id);
      navigate('/playlists');
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const openDeploy = () => {
    if (deviceList.length === 0) {
      setErr('Register a device first.');
      return;
    }
    setDeployDeviceId(deviceList[0].id);
    setDeployOpen(true);
    setErr(null);
    setInfo(null);
  };

  const confirmDeploy = async () => {
    setDeploying(true);
    try {
      await playlistsApi.deploy(playlist.id, deployDeviceId);
      const dev = deviceList.find((d) => d.id === deployDeviceId);
      setInfo(`Deployed to ${dev?.name ?? 'device'}.`);
      setDeployOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <Link to="/playlists" className="muted">← All playlists</Link>
          <h1 style={{ margin: '4px 0 0' }}>{playlist.name}</h1>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button onClick={openDeploy} disabled={busy}>Deploy →</button>
          <button className="danger" onClick={onDelete} disabled={busy}>Delete</button>
        </div>
      </div>

      {err && <div className="error-banner">{err}</div>}
      {info && (
        <div className="card" style={{ background: 'rgba(63,191,111,0.15)', color: 'var(--green)' }}>
          {info}
        </div>
      )}

      <div className="card stack">
        <h3 style={{ marginTop: 0 }}>Details</h3>
        <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div style={{ flex: 2 }}>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={loop}
                onChange={(e) => setLoop(e.target.checked)}
                style={{ width: 'auto' }}
              />
              <span>Loop playlist</span>
            </label>
          </div>
        </div>
      </div>

      <div className="card stack">
        <h3 style={{ marginTop: 0 }}>Items ({items.length})</h3>
        <div className="muted" style={{ fontSize: 13 }}>
          Items play in the order shown. Use ↑/↓ to reorder, ✕ to remove, and the duration field to set how long each one plays.
        </div>

        {items.length === 0 ? (
          <div className="muted" style={{ padding: 12, textAlign: 'center' }}>
            No items yet — add media below.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th style={{ width: 72 }}>Preview</th>
                <th>Media</th>
                <th style={{ width: 140 }}>Duration (sec)</th>
                <th style={{ width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => {
                const m = mediaById.get(it.mediaId);
                return (
                  <tr key={it.mediaId + i}>
                    <td>{i + 1}</td>
                    <td>
                      {m ? (
                        <Thumbnail m={m} size={56} />
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td>
                      {m ? (
                        <>
                          {m.original_name}{' '}
                          <span className="muted" style={{ fontSize: 12 }}>({m.mime_type})</span>
                        </>
                      ) : (
                        <span className="muted">(media deleted)</span>
                      )}
                    </td>
                    <td>
                      {/*
                       * Wire format is milliseconds (what VNNOX consumes); the UI
                       * works in seconds because that's how staff think about ad
                       * playback. 0.5s minimum keeps fast-flash edge cases from
                       * being typoed in, 3600s (1 hour) is the same cap as before.
                       */}
                      <input
                        type="number"
                        min={0.5}
                        max={3600}
                        step={0.5}
                        value={it.durationMs / 1000}
                        onChange={(e) => {
                          const sec = parseFloat(e.target.value);
                          const ms = Number.isFinite(sec) ? Math.round(sec * 1000) : 0;
                          setDuration(i, ms);
                        }}
                      />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <button className="secondary" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                        <button className="secondary" onClick={() => move(i, +1)} disabled={i === items.length - 1}>↓</button>
                        <button className="danger" onClick={() => remove(i)}>✕</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <label>Add / toggle media</label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {mediaList.map((m) => {
              const idx = items.findIndex((it) => it.mediaId === m.id);
              return (
                <button
                  type="button"
                  key={m.id}
                  className={idx >= 0 ? '' : 'secondary'}
                  onClick={() => addItem(m.id)}
                >
                  {idx >= 0 ? `${idx + 1}. ` : '+ '}{m.original_name}
                </button>
              );
            })}
            {mediaList.length === 0 && <span className="muted">Upload media first.</span>}
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="secondary" onClick={() => {
            setName(playlist.name);
            setLoop(playlist.loop);
            setItems(playlistToItems(playlist));
            setInfo(null);
            setErr(null);
          }} disabled={busy}>
            Revert changes
          </button>
          <button onClick={save} disabled={busy || !name}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      {deployOpen && (
        <div
          onClick={() => setDeployOpen(false)}
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
            <h3 style={{ marginTop: 0 }}>Deploy "{playlist.name}"</h3>
            <div>
              <label>Display</label>
              <select value={deployDeviceId} onChange={(e) => setDeployDeviceId(e.target.value)}>
                {deviceList.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}{d.location ? ` — ${d.location}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end', gap: 8 }}>
              <button className="secondary" onClick={() => setDeployOpen(false)} disabled={deploying}>
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
