export type Role = 'super_admin' | 'org_admin' | 'org_operator' | 'org_viewer';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
}

export type DeviceProvider = 'vnnox' | 'lan_direct' | 'mock';

export interface Device {
  id: string;
  organization_id: string;
  provider: DeviceProvider;
  name: string;
  model: string | null;
  device_key: string;
  ip_address: string | null;
  port: number;
  location: string | null;
  width_px: number | null;
  height_px: number | null;
  last_seen_at: string | null;
  online: boolean;
  firmware: string | null;
  metadata: Record<string, unknown>;
  // Brightness automation
  auto_brightness_enabled: boolean;
  latitude: string | null;          // decimal columns serialize as strings from pg
  longitude: string | null;
  brightness_day: number;
  brightness_night: number;
  brightness_offset_minutes: number;
  last_applied_brightness: number | null;
  last_applied_at: string | null;
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
  organization_id: string;
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
  organization_id: string;
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
  organization_id: string | null;
  message: string;
  details: Record<string, unknown> | null;
}

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  organizationId: string | null;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface SignupResponse extends LoginResponse {
  organization: Organization;
}
