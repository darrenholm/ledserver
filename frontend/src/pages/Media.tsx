import { ChangeEvent, useEffect, useState } from 'react';
import { media as mediaApi } from '../api/endpoints';
import { useAuth } from '../auth';
import type { Media } from '../types';

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const THUMB_BOX: React.CSSProperties = {
  width: 80,
  height: 60,
  borderRadius: 4,
  background: 'var(--surface-2, #1f2937)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  fontSize: 11,
  color: 'var(--text-muted, #9ca3af)',
};

function Thumbnail({ m }: { m: Media }) {
  const src = m.thumbnail_url ?? m.storage_url;
  if (m.mime_type.startsWith('image/')) {
    return (
      <div style={THUMB_BOX}>
        <img
          src={src}
          alt=""
          loading="lazy"
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
      </div>
    );
  }
  if (m.mime_type.startsWith('video/')) {
    return (
      <div style={THUMB_BOX}>
        <video
          src={m.storage_url}
          preload="metadata"
          muted
          playsInline
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
      </div>
    );
  }
  if (m.mime_type.startsWith('audio/')) {
    return <div style={THUMB_BOX}>audio</div>;
  }
  return <div style={THUMB_BOX}>file</div>;
}

export default function MediaPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'org_admin' || user?.role === 'super_admin';
  const [items, setItems] = useState<Media[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const refresh = () =>
    mediaApi
      .list()
      .then(setItems)
      .catch((e) => setErr((e as Error).message));

  useEffect(() => {
    refresh();
  }, []);

  const onUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setErr(null);
    setInfo(null);
    try {
      await mediaApi.upload(file);
      refresh();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm('Delete media file? Any playlist using it will lose this item.')) return;
    try {
      await mediaApi.remove(id);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onBackfill = async () => {
    setBackfilling(true);
    setErr(null);
    setInfo(null);
    try {
      const r = await mediaApi.backfillThumbnails();
      setInfo(`Backfill complete: generated ${r.generated} / ${r.candidates} (${r.skipped} skipped, ${r.errors.length} errors).`);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBackfilling(false);
    }
  };

  const missingThumbs = items.filter(
    (m) => m.mime_type.startsWith('image/') && !m.thumbnail_url,
  ).length;

  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Media</h1>
        <div className="row" style={{ gap: 8 }}>
          {isAdmin && missingThumbs > 0 && (
            <button className="secondary" onClick={onBackfill} disabled={backfilling}>
              {backfilling ? 'Generating…' : `Generate ${missingThumbs} missing thumbnail${missingThumbs === 1 ? '' : 's'}`}
            </button>
          )}
          <label className="row" style={{ cursor: 'pointer' }}>
            <input type="file" accept="image/*,video/*,audio/*" onChange={onUpload} hidden />
            <span
              style={{
                background: 'var(--accent)',
                color: 'white',
                padding: '8px 14px',
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              {uploading ? 'Uploading…' : '+ Upload file'}
            </span>
          </label>
        </div>
      </div>

      {err && <div className="error-banner">{err}</div>}
      {info && <div className="success-banner">{info}</div>}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 96 }}>Preview</th>
              <th>Name</th>
              <th>Type</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td><Thumbnail m={m} /></td>
                <td>{m.original_name}</td>
                <td>{m.mime_type}</td>
                <td>{fmtSize(Number(m.size_bytes))}</td>
                <td className="muted">{new Date(m.created_at).toLocaleString()}</td>
                <td>
                  <button className="danger" onClick={() => onDelete(m.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No media uploaded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
