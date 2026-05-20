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
  latitude: string | null;
  longitude: string | null;
  brightness_day: number;
  brightness_night: number;
  brightness_offset_minutes: number;
  last_applied_brightness: number | null;
  last_applied_at: string | null;
  // Rentals
  is_rentable: boolean;
  daily_rate: string | null;
  weekly_rate: string | null;
  monthly_rate: string | null;
  rental_currency: string;
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

export interface ManagedUser {
  id: string;
  username: string;
  role: Role;
  organization_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface SignupResponse extends LoginResponse {
  organization: Organization;
}

// --- Ad-rental marketplace ---

export interface RentableDisplay {
  id: string;
  name: string;
  model: string | null;
  location: string | null;
  width_px: number | null;
  height_px: number | null;
  daily_rate: string | null;
  weekly_rate: string | null;
  monthly_rate: string | null;
  rental_currency: string;
  is_rentable: boolean;
}

export interface RentableDisplayDetail extends RentableDisplay {
  bookedWindows: { start_date: string; end_date: string }[];
}

export type RentalStatus =
  | 'pending_payment'
  | 'pending_review'
  | 'approved'
  | 'active'
  | 'expired'
  | 'rejected'
  | 'cancelled';

export interface PublicRentalStatus {
  id: string;
  status: RentalStatus;
  advertiser_name: string;
  advertiser_email: string;
  start_date: string;
  end_date: string;
  amount_cents: number;
  currency: string;
  artwork_warnings: string[];
  paid_at: string | null;
  review_notes: string | null;
  device_name: string;
  storage_url: string | null;
}

export interface AdminRental extends PublicRentalStatus {
  device_id: string;
  advertiser_phone: string | null;
  advertiser_business: string | null;
  advertiser_notes: string | null;
  duration_unit: 'day' | 'week' | 'month';
  duration_count: number;
  payment_provider: string | null;
  payment_reference: string | null;
  media_id: string | null;
  device_location: string | null;
  artwork_url: string | null;
  artwork_mime: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRentalResponse {
  id: string;
  status: RentalStatus;
  endDate: string;
  amountCents: number;
  currency: string;
  paymentInstructions: string;
}

export interface ArtworkUploadResponse {
  ok: boolean;
  mediaId: string;
  warnings: string[];
  dimensions: { width: number; height: number } | null;
  artworkUrl: string;
}
