import { useEffect, useState } from 'react';
import { users as usersApi } from '../api/endpoints';
import { useAuth } from '../auth';
import type { ManagedUser, Role } from '../types';

const ASSIGNABLE_ROLES: Role[] = ['org_admin', 'org_operator', 'org_viewer'];

export default function Users() {
  const { user: me } = useAuth();
  const [list, setList] = useState<ManagedUser[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Create form
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('org_operator');
  const [creating, setCreating] = useState(false);

  const refresh = () =>
    usersApi
      .list()
      .then(setList)
      .catch((e) => setErr((e as Error).message));

  useEffect(() => {
    refresh();
  }, []);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setInfo(null);
    setCreating(true);
    try {
      await usersApi.create({ username: newUsername.trim(), password: newPassword, role: newRole });
      setNewUsername('');
      setNewPassword('');
      setNewRole('org_operator');
      setInfo(`Created user "${newUsername.trim()}".`);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const onRoleChange = async (u: ManagedUser, role: Role) => {
    setErr(null);
    try {
      await usersApi.update(u.id, { role });
      setInfo(`Updated role for "${u.username}" → ${role}.`);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onResetPassword = async (u: ManagedUser) => {
    const pw = prompt(`Enter a new password for ${u.username} (min 8 chars):`);
    if (!pw) return;
    if (pw.length < 8) {
      setErr('Password must be at least 8 characters.');
      return;
    }
    try {
      await usersApi.update(u.id, { password: pw });
      setInfo(`Password reset for "${u.username}".`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onDelete = async (u: ManagedUser) => {
    if (!confirm(`Delete user "${u.username}"? They will lose access immediately.`)) return;
    try {
      await usersApi.remove(u.id);
      setInfo(`Deleted user "${u.username}".`);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Users</h1>
      <div className="muted" style={{ fontSize: 13 }}>
        Manage who can sign in. Roles control what each user can do — admins can manage users
        and devices; operators can deploy playlists; viewers are read-only.
      </div>

      {err && <div className="error-banner">{err}</div>}
      {info && <div className="success-banner">{info}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Invite a new user</h2>
        <form onSubmit={onCreate} className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 200px' }}>
              <label>Username</label>
              <input
                type="text"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="e.g. jane.smith"
                required
                minLength={3}
                maxLength={60}
              />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <label>Temporary password</label>
              <input
                type="text"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="at least 8 characters"
                required
                minLength={8}
              />
            </div>
            <div style={{ flex: '0 1 160px' }}>
              <label>Role</label>
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <button type="submit" disabled={creating}>
              {creating ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Created</th>
              <th style={{ textAlign: 'right' }}></th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => {
              const isMe = u.id === me?.id;
              const isSuper = u.role === 'super_admin';
              return (
                <tr key={u.id}>
                  <td>
                    {u.username}
                    {isMe && <span className="pill" style={{ marginLeft: 8 }}>you</span>}
                  </td>
                  <td>
                    {isSuper ? (
                      <code>super_admin</code>
                    ) : (
                      <select
                        value={u.role}
                        onChange={(e) => onRoleChange(u, e.target.value as Role)}
                        disabled={isMe}
                      >
                        {ASSIGNABLE_ROLES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="muted">{new Date(u.created_at).toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="secondary"
                      onClick={() => onResetPassword(u)}
                      disabled={isSuper}
                      style={{ marginRight: 6 }}
                    >
                      Reset password
                    </button>
                    <button
                      className="danger"
                      onClick={() => onDelete(u)}
                      disabled={isMe || isSuper}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr>
                <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
