import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/devices', label: 'Devices' },
  { to: '/media', label: 'Media' },
  { to: '/playlists', label: 'Playlists' },
  { to: '/logs', label: 'Logs' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
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
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
          {NAV.map((item) => (
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
