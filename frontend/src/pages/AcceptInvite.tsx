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
      .then((inv) => {
        setInvite(inv);
        // Pre-fill the username with the invitee's email. Most Holm
        // Graphics accounts use the full email as the username
        // (brady@holmgraphics.ca etc.) so it's the right default. The
        // user can always edit it to a shorter handle.
        const cleaned = (inv.email || '').trim().replace(/[^a-zA-Z0-9._@-]/g, '');
        if (cleaned.length >= 3) setUsername(cleaned);
      })
      .catch((e) => setLookupError((e as Error).message));
  }, [token]);

  /**
   * Inline username validation. Mirrors the regex on the input + backend
   * but surfaces a specific message instead of the generic browser
   * "Please match the requested format" or the API's "validation" string.
   * Empty username returns null so the form's required attribute handles
   * the "did you type anything" case.
   */
  const usernameProblem = (() => {
    if (!username) return null;
    if (username.length < 3) return 'Username needs at least 3 characters.';
    if (username.length > 60) return 'Username is too long (60 chars max).';
    if (/\s/.test(username)) return 'No spaces — use your email, or a handle like laura.oliver.';
    if (!/^[a-zA-Z0-9._@-]+$/.test(username))
      return 'Only letters, numbers, dot, dash, underscore, and @ are allowed.';
    return null;
  })();

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
                  placeholder="laura.oliver@ugdsb.on.ca"
                  required
                  minLength={3}
                  maxLength={60}
                  pattern="[a-zA-Z0-9._@-]+"
                  title="Email address, or a handle like laura.oliver"
                  autoFocus
                  style={
                    usernameProblem
                      ? { borderColor: 'var(--red, #dc2626)' }
                      : undefined
                  }
                />
                {usernameProblem ? (
                  <div style={{ color: 'var(--red, #dc2626)', fontSize: 12, marginTop: 4 }}>
                    {usernameProblem}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Your email works, or pick a shorter handle. No spaces.
                  </div>
                )}
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
              <button type="submit" disabled={busy || !!usernameProblem}>
                {busy ? 'Creating account…' : 'Accept and sign in'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
