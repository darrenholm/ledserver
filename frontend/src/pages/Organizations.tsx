import { useEffect, useState } from 'react';
import { organizations as orgsApi } from '../api/endpoints';
import { getOrgScope, setOrgScope } from '../api/client';
import type { Organization } from '../types';

export default function Organizations() {
  const [list, setList] = useState<Organization[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [scope, setScope] = useState<string | null>(getOrgScope());
  // Inline create form.
  const [newOrgName, setNewOrgName] = useState('');
  const [creating, setCreating] = useState(false);

  const refresh = () =>
    orgsApi
      .list()
      .then(setList)
      .catch((e) => setErr((e as Error).message));

  useEffect(() => {
    refresh();
  }, []);

  const switchScope = (next: string | null) => {
    setOrgScope(next);
    setScope(next);
    // hard reload so all pages re-fetch with the new scope
    window.location.assign('/');
  };

  const onDelete = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This removes the org and all its devices, playlists, and media.`)) return;
    try {
      await orgsApi.remove(id);
      if (scope === id) {
        setOrgScope(null);
        setScope(null);
      }
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onCreate = async () => {
    const name = newOrgName.trim();
    if (name.length < 2) {
      setErr('Organization name must be at least 2 characters.');
      return;
    }
    setCreating(true);
    setErr(null);
    try {
      await orgsApi.create(name);
      setNewOrgName('');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Organizations</h1>
      <div className="muted" style={{ fontSize: 13 }}>
        Super-admin view. Switch into a specific org to manage its devices, or stay in "All orgs" mode to see everything.
      </div>

      {err && <div className="error-banner">{err}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0, fontSize: 15 }}>Create organization</h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Each organization gets its own media library, devices, and playlists. Use this for an
          umbrella client like a school board where you want their schools to share a media pool.
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            placeholder="e.g. Upper Grand District School Board"
            value={newOrgName}
            onChange={(e) => setNewOrgName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void onCreate(); }}
            style={{ flex: 1 }}
          />
          <button onClick={onCreate} disabled={creating || newOrgName.trim().length < 2}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Created</th>
              <th>Scope</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={3} style={{ fontStyle: 'italic' }}>All organizations</td>
              <td>
                {scope === null ? (
                  <span className="pill online">active</span>
                ) : (
                  <button className="secondary" onClick={() => switchScope(null)}>Switch</button>
                )}
              </td>
              <td></td>
            </tr>
            {list.map((o) => (
              <tr key={o.id}>
                <td>{o.name}</td>
                <td><code>{o.slug}</code></td>
                <td className="muted">{new Date(o.created_at).toLocaleString()}</td>
                <td>
                  {scope === o.id ? (
                    <span className="pill online">active</span>
                  ) : (
                    <button className="secondary" onClick={() => switchScope(o.id)}>Switch</button>
                  )}
                </td>
                <td>
                  <button className="danger" onClick={() => onDelete(o.id, o.name)}>Delete</button>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No organizations yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
