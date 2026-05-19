import { FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

export default function Signup() {
  const { user, signup } = useAuth();
  const navigate = useNavigate();
  const [organizationName, setOrgName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signup(organizationName, username, password);
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
      <form onSubmit={onSubmit} className="card" style={{ width: 400 }}>
        <h2 style={{ marginTop: 0 }}>Create an account</h2>
        <div className="muted" style={{ marginBottom: 16, fontSize: 13 }}>
          Sign up creates a new organization that owns its own devices and playlists.
        </div>
        <div className="stack">
          <div>
            <label>Organization name</label>
            <input
              value={organizationName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Acme Signs Ltd"
              required
              minLength={2}
              maxLength={120}
              autoFocus
            />
          </div>
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
            {busy ? 'Creating…' : 'Create account'}
          </button>
          <div className="muted" style={{ textAlign: 'center', fontSize: 13 }}>
            Already have an account? <Link to="/login">Sign in</Link>
          </div>
        </div>
      </form>
    </div>
  );
}
