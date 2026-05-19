# NovaStar Taurus Local Control Server

Local-network control server for NovaStar Taurus LED display controllers. Communicates with controllers over the COEX protocol via [`@novastar/net`](https://www.npmjs.com/package/@novastar/net) and serves media to them over HTTP from the bundled nginx.

## Architecture

```
┌────────────┐     HTTP (REST)     ┌─────────────┐    COEX     ┌─────────────────┐
│  Frontend  │────────────────────▶│  Backend    │────────────▶│ Taurus Device 1 │
│  (React)   │                     │  (Express)  │             └─────────────────┘
└────────────┘                     │             │             ┌─────────────────┐
                                   │             │────────────▶│ Taurus Device 2 │
                                   └──────┬──────┘             └─────────────────┘
                                          │                            ▲
                                          ▼                            │
                                   ┌─────────────┐                     │
                                   │ PostgreSQL  │                     │
                                   └─────────────┘            HTTP pull│
                                                                       │
                                   ┌─────────────┐                     │
                                   │   nginx     │─────────────────────┘
                                   │ (media)     │
                                   └─────────────┘
```

- **Backend** — Express + TypeScript. Wraps `@novastar/net` in a `CoexClient`. Exposes REST for devices, playlists, media, logs.
- **Frontend** — React + Vite + TypeScript. Dashboard for device management.
- **Database** — PostgreSQL. Tables: `devices`, `playlists`, `media`, `playlist_items`, `logs`.
- **Media server** — nginx serves `/media/` so Taurus devices can HTTP-pull content.
- **Auth** — JWT + IP whitelist (LAN-only).

## Quickstart

```bash
cp .env.example .env       # edit secrets
docker compose up --build
```

- Frontend: http://localhost:8080
- API: http://localhost:8080/api
- Media: http://localhost:8080/media

Default admin login is set via `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`.

## Dev (without Docker)

```bash
# Postgres must be reachable per .env
cd backend && npm install && npm run migrate && npm run dev
cd frontend && npm install && npm run dev
```

## Tests

```bash
cd backend && npm test
```

Tests use an in-process `MockCoexController` instead of real hardware.

## Production deploy — Railway (recommended)

Single Railway service serves both the API and the frontend behind one domain. The root `Dockerfile` builds the Vite frontend, builds the Express backend, and combines them into one image. Express serves the frontend at `/`, the API at `/api/*`, and media at `/files/*`.

### Architecture on Railway

```
led.holmgraphics.ca/         →  frontend (Vite SPA)
led.holmgraphics.ca/api/*    →  backend (Express)
led.holmgraphics.ca/files/*  →  media (served from /app/media volume)
                                 │
                                 ├─ volume:  /app/media   (uploaded files)
                                 └─ plugin:  Postgres     (managed)
```

Taurus controllers HTTP-pull media from `https://led.holmgraphics.ca/files/uploads/<file>`. They must be configured to phone home (outbound) to the server — direct inbound LAN access from Railway is not possible.

## Device protocol providers

Each registered device picks a transport via its `provider` column:

| Provider | When to use | Identifier (`device_key`) |
|---|---|---|
| `vnnox` (default) | All customer devices. Talks to [NovaStar's NovaCloud Open Platform](https://developer-en.vnnox.com/) API. Works from any cloud host. | Device SN as listed in VNNOX |
| `lan_direct` | In-shop diagnostics only. Direct TCP to port 5200. Requires same-LAN reachability. Most operations stubbed (wire protocol still being decoded). | Any local key |
| `mock` | Tests | n/a |

**To use `vnnox` provider** you need to set `VNNOX_APP_KEY` and `VNNOX_APP_SECRET` (see Variables in the Railway section below). Get them at [developer-en.vnnox.com](https://developer-en.vnnox.com/) — log in with your VNNOX account, create an application, copy the credentials.

Customers never need their own VNNOX credentials. Holm Graphics holds one server-side credential that controls every customer's devices on their behalf; the multi-tenant separation is enforced by our `organizations` model, not by NovaStar's sub-user model.

### Step-by-step

1. **Create Railway project** at https://railway.app/new from the GitHub repo.

2. **Add a Postgres plugin** to the project (Railway dashboard → New → Database → PostgreSQL).

3. **Configure the service:**
   - **Settings → Source → Root Directory:** `/` (repo root — the root `Dockerfile` builds both apps)
   - **Settings → Build → Builder:** Dockerfile
   - **Settings → Deploy → Healthcheck path:** `/health` (auto-set from `railway.json`)
   - **Volume:** mount at `/app/media` (persists uploaded files)
   - **Variables:**
     ```
     NODE_ENV=production
     PORT=4000
     JWT_SECRET=<node -e "console.log(require('crypto').randomBytes(48).toString('base64'))">
     JWT_EXPIRES_IN=12h
     ADMIN_USERNAME=admin
     ADMIN_PASSWORD=<strong unique password>
     DATABASE_URL=${{Postgres.DATABASE_URL}}
     MEDIA_PUBLIC_BASE_URL=https://led.holmgraphics.ca/files

     # VNNOX Cloud (NovaCloud Open Platform) — required for provider=vnnox devices
     VNNOX_REGION=us
     VNNOX_APP_KEY=<from developer-en.vnnox.com>
     VNNOX_APP_SECRET=<from developer-en.vnnox.com>
     ```
     Skip `CORS_ALLOWED_ORIGINS` and `IP_WHITELIST` — same-origin deploy doesn't need CORS, and rate-limiting + auth handle access.

4. **Custom domain:** `led.holmgraphics.ca` — Railway gives you a CNAME + TXT pair.

5. **DNS** — at your DNS provider (cPanel Zone Editor for `holmgraphics.ca`):
   ```
   led       CNAME   <railway-cname-target>
   _railway-verify.led   TXT   <railway-verify-string>
   ```

6. **First deploy** runs migrations via `preDeployCommand`, seeds the admin user, then starts the server. Watch the deployment logs.

## Alternative: self-hosted with Docker Compose

For a single-host deploy (shop machine, VPS, etc.) using the bundled Caddy TLS overlay:

```bash
git clone https://github.com/darrenholm/ledserver /opt/ledserver && cd /opt/ledserver
cp .env.prod.example .env
# fill in JWT_SECRET, ADMIN_PASSWORD, POSTGRES_PASSWORD, LED_DOMAIN
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Caddy will provision a Let's Encrypt cert on first boot. Requires ports 80 and 443 reachable from the public internet.

The API will **refuse to start** in production if `JWT_SECRET`, `ADMIN_PASSWORD`, or `POSTGRES_PASSWORD` are left at default/example values.

### Hardening in this scaffold

- Login is rate-limited to 10 attempts / 15 min per IP.
- JWT tokens expire after `JWT_EXPIRES_IN` (default 12h).
- Bcrypt hashing on user passwords.
- Helmet headers + HSTS + nosniff via Caddy.
- Multer upload cap (500MB).
- Optional IP whitelist (CIDR ranges) — leave empty for public, populate to restrict.

### Hardening still to add (Phase 2)

- TOTP / 2FA for the admin user.
- Audit log for COEX commands (currently logged at info level but not separated).
- Backups for the `postgres_data` volume.
- Fail2ban or equivalent at the host level.

## Open questions (resolve before production)

1. **COEX port** — assumed `5000` (NovaStar standard). Confirm with a real Taurus.
2. **Content delivery** — current design is hybrid: COEX push for control, HTTP pull from nginx for media. Confirm Taurus pulls media on `playlist.play` command.
3. **Device key** — registration expects the key from the Taurus QR sticker. Format/length TBD on first real-device test.

See [`docs/`](./docs) for protocol notes once these are validated.
