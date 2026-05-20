import { useEffect, useState } from 'react';
import { users as usersApi } from '../api/endpoints';
import { useAuth } from '../auth';
import type { ManagedUser, Role, UserInvite } from '../types';

const ASSIGNABLE_ROLES: Role[] = ['org_admin', 'org_operator', 'org_viewer'];

export default function Users() {
  const { user: me } = useAuth();
  const [list, setList] = useState<ManagedUser[]>([]);
  const [invites, setInvites] = useState<UserInvite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('org_operator');
  const [inviting, setInviting] = useState(false);

  const refresh = () => {
    usersApi
      .list()
      .then(setList)
      .catch((e) => setErr((e as Error).message));
    usersApi
      .listInvites()
      .then(setInvites)
      .catch((e) => setErr((e as Error).message));
  };

  useEffect(() => {
    refresh();
  }, []);

  const onInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setInfo(null);
    setInviting(true);
    try {
      await usersApi.invite({ email: inviteEmail.trim(), role: inviteRole });
      setInviteEmail('');
      setInviteRole('org_operator');
      setInfo(`Invitation sent to ${inviteEmail.trim()}.`);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setInviting(false);
    }
  };

  const onResend = async (i: UserInvite) => {
    setErr(null);
    try {
      await usersApi.resendInvite(i.id);
      setInfo(`Re-sent invitation to ${i.email}. The previous link is no longer valid.`);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onRevoke = async (i: UserInvite) => {
    if (!confirm(`Revoke invitation to ${i.email}? The link in their email will stop working.`)) return;
    try {
      await usersApi.revokeInvite(i.id);
      setInfo(`Revoked invitation to ${i.email}.`);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
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
        Invite teammates by email. They pick their own username and password when they accept.
        Roles: admins manage users and devices, operators deploy playlists, viewers are read-only.
      </div>

      {err && <div className="error-banner">{err}</div>}
      {info && <div className="success-banner">{info}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Invite by email</h2>
        <form onSubmit={onInvite} className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px' }}>
              <label>Email</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="jane@example.com"
                required
              />
            </div>
            <div style={{ flex: '0 1 160px' }}>
              <label>Role</label>
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <button type="submit" disabled={inviting}>
              {inviting ? 'Sending…' : 'Send invitation'}
            </button>
          </div>
        </form>
      </div>

      {invites.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Pending invitations</h2>
          </div>
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Sent</th>
                <th>Expires</th>
                <th style={{ textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => {
                const expired = new Date(i.expires_at).getTime() < Date.now();
                return (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td><code>{i.role}</code></td>
                    <td className="muted">{new Date(i.created_at).toLocaleString()}</td>
                    <td className={expired ? '' : 'muted'} style={expired ? { color: 'var(--danger, #b91c1c)' } : undefined}>
                      {expired ? 'expired' : new Date(i.expires_at).toLocaleString()}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="secondary" onClick={() => onResend(i)} style={{ marginRight: 6 }}>
                        Resend
                      </button>
                      <button className="danger" onClick={() => onRevoke(i)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Active users</h2>
        </div>
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
