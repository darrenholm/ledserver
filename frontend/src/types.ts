export interface Device {
  id: string;
  name: string;
  model: string | null;
  device_key: string;
  ip_address: string;
  port: number;
  location: string | null;
  width_px: number | null;
  height_px: number | null;
  last_seen_at: string | null;
  online: boolean;
  firmware: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DeviceStatus {
  online: boolean;
  brightness: number;
  temperatureC?: number;
  currentPlaylistId?: string;
  uptimeSec?: number;
}

export interface Media {
  id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: string;
  duration_ms: number | null;
  storage_url: string;
  created_at: string;
}

export interface Playlist {
  id: string;
  name: string;
  description: string | null;
  loop: boolean;
  created_at: string;
  updated_at: string;
  items?: PlaylistItem[];
}

export interface PlaylistItem {
  id: string;
  playlist_id: string;
  media_id: string;
  position: number;
  duration_ms: number;
  transition: string;
}

export interface LogEntry {
  id: string;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  device_id: string | null;
  message: string;
  details: Record<string, unknown> | null;
}

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}
