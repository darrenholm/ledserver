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

## Production deploy (led.holmgraphics.ca)

Caddy fronts the stack and handles Let's Encrypt automatically. Prereqs:

1. **A server** with a public IP, ports 80 and 443 reachable from the internet, Docker + Compose installed.
2. **DNS** — `led.holmgraphics.ca` A record pointing at that server's public IP.
3. **LAN reachability to the Taurus controllers** — the server must be able to reach each controller's IP. Easiest is to run this on a shop machine; if it's a cloud VPS, set up a Tailscale/WireGuard tunnel to the shop subnet first.

Then on the server:

```bash
git clone <this-repo> /opt/ledserver && cd /opt/ledserver
cp .env.prod.example .env
# fill in JWT_SECRET (openssl rand -base64 48), ADMIN_PASSWORD, POSTGRES_PASSWORD
# leave LED_DOMAIN=led.holmgraphics.ca
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Caddy will provision a TLS cert on first run. Watch logs with:

```bash
docker compose logs -f caddy
```

The API will **refuse to start** in production if `JWT_SECRET`, `ADMIN_PASSWORD`,
or `POSTGRES_PASSWORD` are left at their default/example values.

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
