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

## Open questions (resolve before production)

1. **COEX port** — assumed `5000` (NovaStar standard). Confirm with a real Taurus.
2. **Content delivery** — current design is hybrid: COEX push for control, HTTP pull from nginx for media. Confirm Taurus pulls media on `playlist.play` command.
3. **Device key** — registration expects the key from the Taurus QR sticker. Format/length TBD on first real-device test.

See [`docs/`](./docs) for protocol notes once these are validated.
