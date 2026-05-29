/**
 * Step 1 of the self-service password reset flow.
 *
 * User types their username (handle or email — both work since most
 * accounts use their email as the username). We always show a generic
 * "if it exists, email's on the way" message regardless of hit/miss so
 * an attacker can't enumerate which usernames are real.
 */
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { auth as authApi } from '../api/endpoints';

export default function ForgotPassword() {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await authApi.forgotPassword(username.trim());
      setSent(true);
    } catch (e) {
      // Rate-limit error or transport problem; show but don't reveal whether
      // the account exists.
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
        <h2 style={{ marginTop: 0 }}>Reset your password</h2>
        {sent ? (
          <>
            <p>
              If an account exists for <strong>{username}</strong>, we've sent
              a reset link to its email address. The link expires in 1 hour.
            </p>
            <p className="muted" style={{ fontSize: 13 }}>
              Didn't get the email? Check spam, or wait a minute and try again.
              If your username isn't an email address, the link went to the
              email on file for that account.
            </p>
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <Link to="/login">Back to sign in</Link>
            </div>
          </>
        ) : (
          <form onSubmit={onSubmit} className="stack">
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
              Enter your username or email. We'll send a one-time link to choose
              a new password.
            </p>
            <div>
              <label>Username or email</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="laura.oliver@ugdsb.on.ca"
                autoFocus
                required
                minLength={3}
              />
            </div>
            {err && <div className="error-banner">{err}</div>}
            <button type="submit" disabled={busy || !username.trim()}>
              {busy ? 'Sending…' : 'Send reset link'}
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
