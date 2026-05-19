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

The repo is structured for a 3-service Railway project: backend API, frontend, and managed Postgres. Railway handles TLS, custom domains, and persistent volumes.

### Architecture on Railway

```
led.holmgraphics.ca         →  frontend service  (nginx serving SPA)
api.led.holmgraphics.ca     →  backend service   (Express + media static)
                                 │
                                 ├─ volume:  /app/media   (uploaded files)
                                 └─ plugin:  Postgres     (managed)
```

Taurus controllers HTTP-pull media from `https://api.led.holmgraphics.ca/files/uploads/<file>`. They must be configured to phone home (outbound) to the API — direct inbound LAN access from Railway is not possible.

### Step-by-step

1. **Create Railway project** at https://railway.app/new from the GitHub repo.

2. **Add a Postgres plugin** to the project (Railway dashboard → New → Database → PostgreSQL). It auto-provisions a `DATABASE_URL` variable.

3. **Create the backend service** from the repo's `/backend` directory.
   - Root directory: `backend`
   - Build: Dockerfile (Railway auto-detects)
   - **Variables (set these):**
     ```
     NODE_ENV=production
     JWT_SECRET=<openssl rand -base64 48>
     JWT_EXPIRES_IN=12h
     ADMIN_USERNAME=admin
     ADMIN_PASSWORD=<strong unique password>
     DATABASE_URL=${{Postgres.DATABASE_URL}}        # reference the Postgres plugin
     MEDIA_PUBLIC_BASE_URL=https://api.led.holmgraphics.ca/files
     CORS_ALLOWED_ORIGINS=https://led.holmgraphics.ca
     COEX_DEFAULT_PORT=5000
     IP_WHITELIST=                                  # empty = open; restrict via app auth
     ```
   - **Volume:** add a volume mounted at `/app/media` (persists uploaded files).
   - **Custom domain:** `api.led.holmgraphics.ca` — Railway will give you a CNAME target.

4. **Create the frontend service** from `/frontend`.
   - Root directory: `frontend`
   - Build: Dockerfile
   - **Build-time variable** (build arg `VITE_API_BASE_URL`): `https://api.led.holmgraphics.ca`
   - **Custom domain:** `led.holmgraphics.ca`

5. **DNS** — at your DNS provider (cPanel Zone Editor on swhc.ca, Cloudflare, etc.):
   ```
   led.holmgraphics.ca       CNAME   <railway-frontend-cname>
   api.led.holmgraphics.ca   CNAME   <railway-backend-cname>
   ```

6. **First deploy** runs migrations and seeds the admin user. Watch the backend service logs.

### Why these settings

- `DATABASE_URL` is auto-injected when you wire the Postgres plugin into the service.
- `MEDIA_PUBLIC_BASE_URL` is the URL Taurus controllers will use to fetch media files.
- `CORS_ALLOWED_ORIGINS` restricts who can call the API from a browser — the frontend lives on a different subdomain.
- Login is already rate-limited (10/15min/IP) so an empty `IP_WHITELIST` is acceptable for a public deploy.

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
