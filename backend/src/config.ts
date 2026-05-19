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

// Postgres: prefer DATABASE_URL (Railway, Heroku, etc.) when present.
// Fall back to discrete POSTGRES_* env vars for docker-compose / local dev.
const databaseUrl = process.env.DATABASE_URL;
let pgConfig: { connectionString?: string; host: string; port: number; database: string; user: string; password: string; ssl?: boolean };
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  pgConfig = {
    connectionString: databaseUrl,
    host: parsed.hostname,
    port: parseInt(parsed.port || '5432', 10),
    database: parsed.pathname.replace(/^\//, ''),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl: parsed.searchParams.get('sslmode') !== 'disable' && isProd,
  };
} else {
  const pgPassword = prodSafe('POSTGRES_PASSWORD', process.env.POSTGRES_PASSWORD) || 'novastar';
  pgConfig = {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: int('POSTGRES_PORT', 5432),
    database: process.env.POSTGRES_DB ?? 'novastar',
    user: process.env.POSTGRES_USER ?? 'novastar',
    password: pgPassword,
  };
}

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
  // Railway and some PaaS providers inject PORT; fall back to API_PORT for compose / local.
  apiPort: int('PORT', int('API_PORT', 4000)),

  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  },

  ipWhitelist: (process.env.IP_WHITELIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '')
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

  vnnox: {
    // Region: us | eu | au | in (matches NovaStar's open-<region>.vnnox.com naming)
    region: (process.env.VNNOX_REGION ?? 'us') as 'us' | 'eu' | 'au' | 'in',
    appKey: process.env.VNNOX_APP_KEY ?? '',
    appSecret: process.env.VNNOX_APP_SECRET ?? '',
    timeoutMs: int('VNNOX_TIMEOUT_MS', 10_000),
  },

  // Email (Resend) — used for rental approval / advertiser notifications.
  // If RESEND_API_KEY is empty the email helper logs and no-ops, so dev still works.
  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    fromAddress: process.env.MAIL_FROM ?? 'LED Control <no-reply@holmgraphics.ca>',
    adminAddress: process.env.RENTAL_ADMIN_EMAIL ?? 'darren@holmgraphics.ca',
  },

  // Public base URL used to build links inside emails (approve/reject buttons,
  // status pages, etc.). Falls back to MEDIA_PUBLIC_BASE_URL's host or localhost.
  publicBaseUrl:
    process.env.PUBLIC_BASE_URL ??
    (process.env.MEDIA_PUBLIC_BASE_URL
      ? process.env.MEDIA_PUBLIC_BASE_URL.replace(/\/?files\/?$/, '').replace(/\/?$/, '')
      : 'http://localhost:8080'),

  postgres: pgConfig,

  mediaPublicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL ?? 'http://localhost:8080/media',
};

export type Config = typeof config;
