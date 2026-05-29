/**
 * Step 2 of the self-service password reset flow.
 *
 * Lands here via the email link with ?token=... in the URL. User sets a
 * new password (with a confirm field to catch typos) and submits. On
 * success, the backend has already invalidated all other open resets
 * for this user, so the user is good to go — kick them to /login to
 * sign in with the new password.
 */
import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { auth as authApi } from '../api/endpoints';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg)',
        }}
      >
        <div className="card" style={{ width: 360 }}>
          <h2 style={{ marginTop: 0 }}>Missing reset token</h2>
          <p>This page needs to be opened from the link in your reset email.</p>
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <Link to="/forgot-password">Request a new link</Link>
          </div>
        </div>
      </div>
    );
  }

  // Inline check so submit can stay disabled until both fields agree.
  // Empty confirm returns null so we don't yell at people just for not
  // having finished typing yet.
  const mismatch = confirm && password !== confirm ? "Passwords don't match." : null;
  const tooShort = password && password.length < 8 ? 'At least 8 characters.' : null;
  const problem = tooShort || mismatch;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setErr(null);
    try {
      await authApi.resetPassword(token, password);
      setDone(true);
      // Quick beat so the user sees the success state, then off to login.
      setTimeout(() => navigate('/login'), 1500);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
      }}
    >
      <div className="card" style={{ width: 360 }}>
        <h2 style={{ marginTop: 0 }}>Choose a new password</h2>
        {done ? (
          <>
            <div className="success-banner">Password updated. Redirecting to sign in…</div>
          </>
        ) : (
          <form onSubmit={onSubmit} className="stack">
            <div>
              <label>New password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                required
                minLength={8}
              />
              {tooShort && (
                <div style={{ color: 'var(--red, #dc2626)', fontSize: 12, marginTop: 4 }}>
                  {tooShort}
                </div>
              )}
            </div>
            <div>
              <label>Confirm new password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
              />
              {mismatch && (
                <div style={{ color: 'var(--red, #dc2626)', fontSize: 12, marginTop: 4 }}>
                  {mismatch}
                </div>
              )}
            </div>
            {err && <div className="error-banner">{err}</div>}
            <button type="submit" disabled={busy || !!problem || !password || !confirm}>
              {busy ? 'Updating…' : 'Update password'}
            </button>
            <div className="muted" style={{ textAlign: 'center', fontSize: 13 }}>
              <Link to="/login">Back to sign in</Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
