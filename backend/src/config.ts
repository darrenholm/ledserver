import dotenv from 'dotenv';

dotenv.config();

const FORBIDDEN_PROD_VALUES = {
  JWT_SECRET: new Set(['change-me-to-a-long-random-string', 'dev-only-secret-do-not-use-in-prod', '']),
  ADMIN_PASSWORD: new Set(['changeme', 'admin', 'password', '']),
  POSTGRES_PASSWORD: new Set(['novastar', 'postgres', 'password', '']),
};

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got: ${v}`);
  return n;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProd = nodeEnv === 'production';

function prodSafe(name: keyof typeof FORBIDDEN_PROD_VALUES, value: string | undefined): string {
  if (isProd) {
    if (!value || FORBIDDEN_PROD_VALUES[name].has(value)) {
      throw new Error(
        `Refusing to start: env var ${name} is unset or matches a known-default value. ` +
          `Set a strong unique value before running in production.`,
      );
    }
  }
  return value ?? '';
}

const jwtSecret = prodSafe('JWT_SECRET', process.env.JWT_SECRET) || 'dev-only-secret-do-not-use-in-prod';
const adminPassword = prodSafe('ADMIN_PASSWORD', process.env.ADMIN_PASSWORD) || 'changeme';
const pgPassword = prodSafe('POSTGRES_PASSWORD', process.env.POSTGRES_PASSWORD) || 'novastar';

if (isProd && (process.env.IP_WHITELIST ?? '') === '') {
  // eslint-disable-next-line no-console
  console.warn(
    '[config] WARNING: IP_WHITELIST is empty in production. ' +
      'The API will accept connections from anywhere. ' +
      'Set IP_WHITELIST to lock down access, or rely on rate-limiting + auth only.',
  );
}

export const config = {
  nodeEnv,
  isProd,
  apiPort: int('API_PORT', 4000),

  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  },

  ipWhitelist: (process.env.IP_WHITELIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  admin: {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: adminPassword,
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
    password: pgPassword,
  },

  mediaPublicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL ?? 'http://localhost:8080/media',
};

export type Config = typeof config;
