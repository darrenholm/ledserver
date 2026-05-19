-- Initial schema: users, devices, playlists, media, playlist_items, logs

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator', 'viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  model         TEXT,
  device_key    TEXT NOT NULL UNIQUE,       -- from QR sticker
  ip_address    INET NOT NULL,
  port          INTEGER NOT NULL DEFAULT 5000,
  location      TEXT,
  width_px      INTEGER,
  height_px     INTEGER,
  last_seen_at  TIMESTAMPTZ,
  online        BOOLEAN NOT NULL DEFAULT FALSE,
  firmware      TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX devices_online_idx ON devices(online);
CREATE INDEX devices_ip_idx ON devices(ip_address);

CREATE TABLE media (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  duration_ms   INTEGER,                    -- for video/audio
  width_px      INTEGER,
  height_px     INTEGER,
  checksum_sha256 TEXT,
  storage_url   TEXT NOT NULL,              -- public URL Taurus pulls from
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE playlists (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  loop          BOOLEAN NOT NULL DEFAULT TRUE,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE playlist_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id   UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id      UUID NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  position      INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL DEFAULT 10000,  -- override default for images
  transition    TEXT NOT NULL DEFAULT 'cut',
  UNIQUE (playlist_id, position)
);
CREATE INDEX playlist_items_playlist_idx ON playlist_items(playlist_id);

CREATE TABLE device_playlists (
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  playlist_id   UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, playlist_id)
);

CREATE TABLE logs (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level         TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  source        TEXT NOT NULL,              -- 'coex', 'api', 'device', etc.
  device_id     UUID REFERENCES devices(id) ON DELETE SET NULL,
  message       TEXT NOT NULL,
  details       JSONB
);
CREATE INDEX logs_ts_idx ON logs(ts DESC);
CREATE INDEX logs_device_idx ON logs(device_id, ts DESC);
CREATE INDEX logs_level_idx ON logs(level);
