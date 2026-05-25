import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';

/**
 * Entry point for SSO from holmgraphics.ca's staff jobs board.
 *
 * The shop sidebar's "LED Screens" link opens this route with the staff's
 * shop-api JWT in the URL hash (?shopToken=… also accepted as a fallback
 * for tooling that strips fragments).
 *
 *   https://led.holmgraphics.ca/sso#shopToken=<jwt>
 *
 * We hand the token to the backend, which verifies the signature with the
 * shared secret, find-or-creates a LED super_admin matching the staff
 * email, and returns a LED-realm JWT. That gets stored via the regular
 * AuthProvider so the user lands in the LED app already signed in.
 *
 * URL hash preferred because hashes never leave the browser — the token
 * doesn't appear in Railway access logs or our own request logs. Query
 * string still works for testing / curl.
 */
function readTokenFromUrl(searchParams: URLSearchParams): string | null {
  // Prefer hash (private), fall back to query param (testable).
  if (typeof window !== 'undefined' && window.location.hash) {
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const fromHash = params.get('shopToken');
    if (fromHash) return fromHash;
  }
  return searchParams.get('shopToken');
}

export default function SsoFromShop() {
  const { user, ssoFromShop } = useAuth();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<'pending' | 'ok' | 'error'>('pending');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const shopToken = readTokenFromUrl(searchParams);
    if (!shopToken) {
      setStatus('error');
      setErr(
        'No shop token in the URL. Make sure you clicked the "LED Screens" ' +
        'link from the jobs board sidebar — that link forwards your sign-in.',
      );
      return;
    }
    (async () => {
      try {
        await ssoFromShop(shopToken);
        // Clear the token from the URL so a future refresh doesn't try to
        // SSO with a stale value (and so the token isn't in browser history).
        if (typeof window !== 'undefined') {
          window.history.replaceState(null, '', '/');
        }
        setStatus('ok');
      } catch (e) {
        setStatus('error');
        setErr((e as Error)?.message || 'SSO failed.');
      }
    })();
    // ssoFromShop comes from context and is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Already signed in (either we just SSO'd or the user landed here with
  // an existing session) → punt to the dashboard.
  if (user && status === 'ok') return <Navigate to="/" replace />;

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <h1>Signing in from Holm Graphics…</h1>
        {status === 'pending' && (
          <p className="muted">
            Verifying your jobs-board session. This usually takes less than a second.
          </p>
        )}
        {status === 'error' && (
          <>
            <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>
            <p className="muted" style={{ marginTop: 12 }}>
              <Link to="/login">Sign in with a direct LED account →</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
