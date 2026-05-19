import { ChangeEvent, useEffect, useState } from 'react';
import { media as mediaApi } from '../api/endpoints';
import type { Media } from '../types';

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function MediaPage() {
  const [items, setItems] = useState<Media[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

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

  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Media</h1>
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

      {err && <div className="error-banner">{err}</div>}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
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
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
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
