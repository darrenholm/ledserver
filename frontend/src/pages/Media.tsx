import { ChangeEvent, useEffect, useState } from 'react';
import { media as mediaApi } from '../api/endpoints';
import { useAuth } from '../auth';
import { Thumbnail } from '../components/Thumbnail';
import type { Media, MediaWithUsage } from '../types';

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

type DuplicatesResponse = Awaited<ReturnType<typeof mediaApi.duplicates>>;

export default function MediaPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'org_admin' || user?.role === 'super_admin';
  const [items, setItems] = useState<Media[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const [dupes, setDupes] = useState<DuplicatesResponse | null>(null);
  const [dupesOpen, setDupesOpen] = useState(false);
  const [dupesLoading, setDupesLoading] = useState(false);

  const refresh = () =>
    mediaApi
      .list()
      .then(setItems)
      .catch((e) => setErr((e as Error).message));

  const refreshDupes = async () => {
    setDupesLoading(true);
    try {
      const d = await mediaApi.duplicates();
      setDupes(d);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDupesLoading(false);
    }
  };

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
      if (dupesOpen) refreshDupes();
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
      if (dupesOpen) refreshDupes();
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

  const onToggleDupes = async () => {
    const next = !dupesOpen;
    setDupesOpen(next);
    if (next && !dupes) await refreshDupes();
  };

  const missingThumbs = items.filter(
    (m) => m.mime_type.startsWith('image/') && !m.thumbnail_url,
  ).length;

  const dupeCount =
    (dupes?.byChecksum.reduce((n, g) => n + g.count, 0) ?? 0) +
    (dupes?.byName.reduce((n, g) => n + g.count, 0) ?? 0);

  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Media</h1>
        <div className="row" style={{ gap: 8 }}>
          {isAdmin && (
            <button className="secondary" onClick={onToggleDupes} disabled={dupesLoading}>
              {dupesLoading
                ? 'Scanning…'
                : dupesOpen
                  ? 'Hide duplicates'
                  : dupes
                    ? `Find duplicates (${dupeCount} flagged)`
                    : 'Find duplicates'}
            </button>
          )}
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

      {dupesOpen && dupes && <DuplicatesPanel data={dupes} onDelete={onDelete} />}

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

/**
 * Renders the two duplicate groupings (exact-bytes and same-filename). The
 * "exact" section is safe to bulk-clean; the "same filename, different bytes"
 * section is where re-exports go to hide — admin needs to look at the
 * thumbnails and decide. We don't pre-select anything; the user clicks Delete
 * on whichever rows they want to drop.
 */
function DuplicatesPanel({
  data,
  onDelete,
}: {
  data: DuplicatesResponse;
  onDelete: (id: string) => void;
}) {
  const empty = data.byChecksum.length === 0 && data.byName.length === 0;
  return (
    <div className="card" style={{ borderColor: '#f59e0b' }}>
      <h3 style={{ marginTop: 0 }}>Duplicate uploads</h3>
      {empty && (
        <p className="muted" style={{ margin: 0 }}>
          No duplicates found. Every file is unique by content and filename.
        </p>
      )}

      {data.byChecksum.length > 0 && (
        <>
          <h4 style={{ marginBottom: 4 }}>Exact duplicates ({data.byChecksum.length} group{data.byChecksum.length === 1 ? '' : 's'})</h4>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            These rows are bit-for-bit identical (same checksum). Safe to delete any
            of them as long as the one you keep is the one your playlists / contracts
            point at — check the Playlists page if you're unsure.
          </p>
          {data.byChecksum.map((g) => (
            <DupeGroup
              key={g.checksum_sha256}
              label={`${g.count} copies — checksum ${g.checksum_sha256.slice(0, 12)}…`}
              items={g.items}
              onDelete={onDelete}
            />
          ))}
        </>
      )}

      {data.byName.length > 0 && (
        <>
          <h4 style={{ marginBottom: 4, marginTop: 16 }}>
            Same filename, different bytes ({data.byName.length} group{data.byName.length === 1 ? '' : 's'})
          </h4>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            These rows share a filename but the files differ — usually because the
            artwork was re-exported and re-uploaded under the same name. Compare the
            thumbnails to figure out which is current. Delete the stale one(s).
          </p>
          {data.byName.map((g) => (
            <DupeGroup
              key={g.original_name}
              label={`${g.count} uploads named "${g.original_name}"`}
              items={g.items}
              onDelete={onDelete}
            />
          ))}
        </>
      )}
    </div>
  );
}

function DupeGroup({
  label,
  items,
  onDelete,
}: {
  label: string;
  items: MediaWithUsage[];
  onDelete: (id: string) => void;
}) {
  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{label}</div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        {items.map((m) => {
          const inPlaylists = m.usage.playlist_items;
          const inRentals = m.usage.rentals;
          const blocked = inPlaylists > 0;
          const isOrphan = inPlaylists === 0 && inRentals === 0;
          return (
            <div
              key={m.id}
              style={{
                border: isOrphan ? '2px solid #f59e0b' : '1px solid var(--border)',
                borderRadius: 6,
                padding: 8,
                width: 180,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                background: isOrphan ? 'rgba(245, 158, 11, 0.06)' : undefined,
              }}
            >
              <Thumbnail m={m} />
              <div style={{ fontSize: 12, wordBreak: 'break-all' }}>{m.original_name}</div>
              <div className="muted" style={{ fontSize: 11 }}>
                {fmtSize(Number(m.size_bytes))} · {new Date(m.created_at).toLocaleDateString()}
              </div>
              <div className="muted" style={{ fontSize: 11, fontFamily: 'monospace' }}>
                {m.id.slice(0, 8)}…
              </div>
              {isOrphan ? (
                <div style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>
                  Not used anywhere — likely the orphan
                </div>
              ) : (
                <div style={{ fontSize: 11 }}>
                  {inPlaylists > 0 && (
                    <div style={{ color: '#ef4444' }}>
                      In {inPlaylists} playlist item{inPlaylists === 1 ? '' : 's'}
                    </div>
                  )}
                  {inRentals > 0 && (
                    <div className="muted">
                      In {inRentals} rental{inRentals === 1 ? '' : 's'}
                    </div>
                  )}
                </div>
              )}
              <button
                className="danger"
                style={{ fontSize: 12, opacity: blocked ? 0.5 : 1 }}
                disabled={blocked}
                title={blocked ? 'Remove from playlist(s) first' : undefined}
                onClick={() => onDelete(m.id)}
              >
                {blocked ? 'In use' : 'Delete'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
