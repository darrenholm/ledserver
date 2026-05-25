import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Signup from './pages/Signup';
import AcceptInvite from './pages/AcceptInvite';
import SsoFromShop from './pages/SsoFromShop';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import DeviceDetail from './pages/DeviceDetail';
import DevicesBulkImport from './pages/DevicesBulkImport';
import MediaPage from './pages/Media';
import Playlists from './pages/Playlists';
import PlaylistDetail from './pages/PlaylistDetail';
import Logs from './pages/Logs';
import Organizations from './pages/Organizations';
import Users from './pages/Users';
import Rent from './pages/Rent';
import RentDisplay from './pages/RentDisplay';
import RentOrder from './pages/RentOrder';
import Rentals from './pages/Rentals';
import RentalDetail from './pages/RentalDetail';
import AdContracts from './pages/AdContracts';
import AdContractDetail from './pages/AdContractDetail';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function RequireSuperAdmin({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'super_admin') return <Navigate to="/" replace />;
  return children;
}

function RequireOrgAdmin({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'super_admin' && user.role !== 'org_admin') return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public auth screens */}
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
        {/* SSO handoff from holmgraphics.ca jobs board (no LED login required). */}
        <Route path="/sso" element={<SsoFromShop />} />

        {/* Public ad-rental marketplace (no login) */}
        <Route path="/rent" element={<Rent />} />
        <Route path="/rent/displays/:id" element={<RentDisplay />} />
        <Route path="/rent/orders/:id" element={<RentOrder />} />

        {/* Authenticated app */}
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="devices" element={<Devices />} />
          <Route
            path="devices/bulk-import"
            element={
              <RequireSuperAdmin>
                <DevicesBulkImport />
              </RequireSuperAdmin>
            }
          />
          <Route path="devices/:id" element={<DeviceDetail />} />
          <Route path="media" element={<MediaPage />} />
          <Route path="playlists" element={<Playlists />} />
          <Route path="playlists/:id" element={<PlaylistDetail />} />
          <Route path="logs" element={<Logs />} />
          <Route
            path="users"
            element={
              <RequireOrgAdmin>
                <Users />
              </RequireOrgAdmin>
            }
          />
          <Route
            path="organizations"
            element={
              <RequireSuperAdmin>
                <Organizations />
              </RequireSuperAdmin>
            }
          />
          <Route
            path="rentals"
            element={
              <RequireSuperAdmin>
                <Rentals />
              </RequireSuperAdmin>
            }
          />
          <Route
            path="rentals/:id"
            element={
              <RequireSuperAdmin>
                <RentalDetail />
              </RequireSuperAdmin>
            }
          />
          <Route
            path="ad-contracts"
            element={
              <RequireSuperAdmin>
                <AdContracts />
              </RequireSuperAdmin>
            }
          />
          <Route
            path="ad-contracts/:id"
            element={
              <RequireSuperAdmin>
                <AdContractDetail />
              </RequireSuperAdmin>
            }
          />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
