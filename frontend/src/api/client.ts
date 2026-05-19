const BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const TOKEN_KEY = 'novastar.token';
const ORG_SCOPE_KEY = 'novastar.orgScope';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Super-admin org override: 'all' = all orgs, or a specific org id. Ignored by the backend for non-super-admins. */
export function getOrgScope(): string | null {
  return localStorage.getItem(ORG_SCOPE_KEY);
}
export function setOrgScope(orgId: string | null): void {
  if (orgId) localStorage.setItem(ORG_SCOPE_KEY, orgId);
  else localStorage.removeItem(ORG_SCOPE_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; formData?: FormData } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const orgScope = getOrgScope();
  if (orgScope) headers['X-Org-Id'] = orgScope;
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, (data as any)?.error ?? res.statusText, data);
  }
  return data as T;
}
