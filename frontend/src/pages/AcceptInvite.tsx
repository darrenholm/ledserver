import { FormEvent, useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { auth as authApi } from '../api/endpoints';
import { useAuth } from '../auth';
import type { InviteLookup } from '../types';

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { user, acceptInvite } = useAuth();
  const navigate = useNavigate();

  const [invite, setInvite] = useState<InviteLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setLookupError('Missing invitation token. Use the link from your email.');
      return;
    }
    authApi
      .lookupInvite(token)
      .then(setInvite)
      .catch((e) => setLookupError((e as Error).message));
  }, [token]);

  // Already signed in? Skip — they're somebody else's account; better to log out first.
  if (user) return <Navigate to="/" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(token, username, password);
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        padding: 20,
      }}
    >
      <div className="card" style={{ width: 420 }}>
        <h2 style={{ marginTop: 0 }}>Accept invitation</h2>

        {lookupError && (
          <div className="error-banner" style={{ marginTop: 8 }}>{lookupError}</div>
        )}

        {!lookupError && !invite && (
          <div className="muted">Loading invitation…</div>
        )}

        {invite && (
          <>
            <div className="muted" style={{ marginBottom: 16, fontSize: 13 }}>
              You've been invited to <strong>{invite.organizationName}</strong> as <code>{invite.role}</code> ({invite.email}).
              Pick a username and password to finish setting up your account.
            </div>
            <form onSubmit={onSubmit} className="stack">
              <div>
                <label>Username</label>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="janedoe"
                  required
                  minLength={3}
                  maxLength={60}
                  pattern="[a-zA-Z0-9._-]+"
                  title="Letters, numbers, dot, underscore, or dash"
                  autoFocus
                />
              </div>
              <div>
                <label>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  At least 8 characters.
                </div>
              </div>
              {error && <div className="error-banner">{error}</div>}
              <button type="submit" disabled={busy}>
                {busy ? 'Creating account…' : 'Accept and sign in'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
