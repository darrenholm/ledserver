import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { auth as authApi } from './api/endpoints';
import { getToken, setOrgScope, setToken } from './api/client';
import type { AuthUser } from './types';

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  signup: (organizationName: string, username: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

function decodeUser(token: string): AuthUser | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return {
      id: payload.sub,
      username: payload.username,
      role: payload.role,
      organizationId: payload.orgId ?? null,
    };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = getToken();
    if (t) setUser(decodeUser(t));
    setLoading(false);
  }, []);

  const login = async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    setToken(res.token);
    setOrgScope(null);
    setUser(res.user);
  };

  const signup = async (organizationName: string, username: string, password: string) => {
    const res = await authApi.signup(organizationName, username, password);
    setToken(res.token);
    setOrgScope(null);
    setUser(res.user);
  };

  const logout = () => {
    setToken(null);
    setOrgScope(null);
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, login, signup, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
