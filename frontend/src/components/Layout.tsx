import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { getOrgScope } from '../api/client';
import { organizations as orgsApi } from '../api/endpoints';
import type { Organization } from '../types';

const NAV_BASE = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/devices', label: 'Devices' },
  { to: '/media', label: 'Media' },
  { to: '/playlists', label: 'Playlists' },
  { to: '/logs', label: 'Logs' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isSuperAdmin = user?.role === 'super_admin';
  const nav = isSuperAdmin
    ? [
        ...NAV_BASE,
        { to: '/rentals', label: 'Ad rentals', end: false },
        { to: '/organizations', label: 'Organizations', end: false },
      ]
    : NAV_BASE;

  const scopeId = getOrgScope();
  const [scopeOrg, setScopeOrg] = useState<Organization | null>(null);

  useEffect(() => {
    if (!isSuperAdmin) return;
    if (!scopeId) {
      setScopeOrg(null);
      return;
    }
    orgsApi
      .list()
      .then((all) => setScopeOrg(all.find((o) => o.id === scopeId) ?? null))
      .catch(() => undefined);
  }, [isSuperAdmin, scopeId]);

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside
        style={{
          width: 220,
          background: 'var(--surface)',
          borderRight: '1px solid var(--border)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <h2 style={{ margin: '0 0 20px', fontSize: 16 }}>NovaStar Taurus</h2>

        {isSuperAdmin && (
          <div
            className="card"
            style={{
              marginBottom: 12,
              padding: '8px 10px',
              background: 'var(--surface-2)',
              fontSize: 12,
            }}
          >
            <div className="muted" style={{ marginBottom: 2 }}>Scope</div>
            <div style={{ fontWeight: 500 }}>
              {scopeOrg ? scopeOrg.name : 'All organizations'}
            </div>
            <NavLink to="/organizations" style={{ fontSize: 12 }}>Change…</NavLink>
          </div>
        )}

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={({ isActive }) => ({
                padding: '8px 12px',
                borderRadius: 6,
                color: isActive ? 'var(--accent)' : 'var(--text)',
                background: isActive ? 'rgba(79, 140, 255, 0.1)' : 'transparent',
                textDecoration: 'none',
                fontSize: 14,
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
          <div className="muted" style={{ marginBottom: 8 }}>
            {user?.username} <span style={{ opacity: 0.6 }}>({user?.role})</span>
          </div>
          <button
            className="secondary"
            onClick={() => {
              logout();
              navigate('/login');
            }}
            style={{ width: '100%' }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
        <Outlet />
      </main>
    </div>
  );
}
