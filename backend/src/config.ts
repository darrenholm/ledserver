import dotenv from 'dotenv';

dotenv.config();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got: ${v}`);
  return n;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  apiPort: int('API_PORT', 4000),

  jwt: {
    secret: required('JWT_SECRET', 'dev-only-secret-do-not-use-in-prod'),
    expiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  },

  ipWhitelist: (process.env.IP_WHITELIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  admin: {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? 'changeme',
  },

  coex: {
    defaultPort: int('COEX_DEFAULT_PORT', 5000),
    timeoutMs: int('COEX_TIMEOUT_MS', 5000),
    retries: int('COEX_RETRIES', 2),
  },

  postgres: {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: int('POSTGRES_PORT', 5432),
    database: process.env.POSTGRES_DB ?? 'novastar',
    user: process.env.POSTGRES_USER ?? 'novastar',
    password: process.env.POSTGRES_PASSWORD ?? 'novastar',
  },

  mediaPublicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL ?? 'http://localhost:8080/media',
};

export type Config = typeof config;
