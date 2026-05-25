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

  // Holm Graphics shop-api bridge (for QuickBooks Payments).
  // The shop-api hosts the QB OAuth tokens and exposes /api/internal endpoints
  // we call to tokenize cards and charge them.
  shopApi: {
    baseUrl: process.env.SHOP_API_BASE_URL ?? '',
    bridgeSecret: process.env.LED_SHOP_BRIDGE_SECRET ?? '',
  },

  // Self-serve advertiser portal: customer JWTs are minted by shop-api on
  // holmgraphics.ca/login, then sent to /api/public/my-rentals here.
  // The secret MUST match shop-api's JWT_SECRET; if they drift, every
  // customer call to the LED app gets a 401.
  customerJwt: {
    // Falls back to the same JWT_SECRET we use for staff so a single-secret
    // setup still works; production should set CUSTOMER_JWT_SECRET explicitly
    // to the same value as shop-api's JWT_SECRET.
    secret: process.env.CUSTOMER_JWT_SECRET || jwtSecret,
  },

  // SSO bridge for shop staff: a click on "LED Screens" in the shop sidebar
  // forwards the user's shop-api staff JWT here; we verify it (with the
  // same shop-api signing secret), find-or-create a matching LED user with
  // super_admin role, and issue a LED JWT. The secret typically matches
  // CUSTOMER_JWT_SECRET (both should equal shop-api's JWT_SECRET); the
  // explicit env var lets you rotate them independently if needed.
  shopStaffJwt: {
    secret: process.env.SHOP_STAFF_JWT_SECRET || process.env.CUSTOMER_JWT_SECRET || jwtSecret,
  },

  // Ad-contract renewal cron. Wired up but DORMANT by default — flip
  // RENEWAL_AUTO_INVOICE=true in env to enable. When enabled, the cron
  // scans ad_contracts where auto_renew=true AND end_date is within
  // RENEWAL_LEAD_DAYS, mints a QBO invoice via shop-api, and stamps
  // renewal_invoice_id so the same term never gets billed twice.
  renewal: {
    autoInvoiceEnabled: (process.env.RENEWAL_AUTO_INVOICE ?? 'false').toLowerCase() === 'true',
    leadDays: int('RENEWAL_LEAD_DAYS', 30),
  },

  postgres: pgConfig,

  mediaPublicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL ?? 'http://localhost:8080/media',
};

export type Config = typeof config;
