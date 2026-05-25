import { api } from './client';
import type {
  AdminRental,
  ArtworkUploadResponse,
  CreateRentalResponse,
  Device,
  DeviceStatus,
  LogEntry,
  LoginResponse,
  InviteLookup,
  ManagedUser,
  Media,
  Organization,
  Playlist,
  PublicRentalStatus,
  RentableDisplay,
  RentableDisplayDetail,
  Role,
  SignupResponse,
  UserInvite,
  UserInviteSendResult,
} from '../types';

export const auth = {
  login: (username: string, password: string) =>
    api<LoginResponse>('/auth/login', { body: { username, password } }),
  signup: (organizationName: string, username: string, password: string) =>
    api<SignupResponse>('/auth/signup', { body: { organizationName, username, password } }),
  lookupInvite: (token: string) => api<InviteLookup>(`/auth/invite/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, username: string, password: string) =>
    api<LoginResponse>(`/auth/invite/${encodeURIComponent(token)}/accept`, {
      body: { username, password },
    }),
  /**
   * Single sign-on from holmgraphics.ca's staff jobs board. Pass the
   * shop-api staff JWT (hg_token in the shop's localStorage); backend
   * verifies it, find-or-creates a matching LED super_admin user, and
   * returns a LED-realm JWT we can store like a normal login.
   */
  ssoFromShop: (shopToken: string) =>
    api<LoginResponse>('/auth/sso-from-shop', { body: { shopToken } }),
};

export const users = {
  list: () => api<ManagedUser[]>('/users'),
  create: (data: { username: string; password: string; role: Role }) =>
    api<ManagedUser>('/users', { body: data }),
  update: (id: string, data: { password?: string; role?: Role }) =>
    api<ManagedUser>(`/users/${id}`, { method: 'PATCH', body: data }),
  remove: (id: string) => api<void>(`/users/${id}`, { method: 'DELETE' }),
  listInvites: () => api<UserInvite[]>('/users/invites'),
  invite: (data: { email: string; role: Role }) =>
    api<UserInviteSendResult>('/users/invites', { body: data }),
  resendInvite: (id: string) =>
    api<UserInviteSendResult>(`/users/invites/${id}/resend`, { method: 'POST' }),
  revokeInvite: (id: string) => api<void>(`/users/invites/${id}`, { method: 'DELETE' }),
};

export const organizations = {
  list: () => api<Organization[]>('/organizations'),
  me: () => api<Organization>('/organizations/me'),
  update: (id: string, data: { name?: string }) =>
    api<Organization>(`/organizations/${id}`, { method: 'PATCH', body: data }),
  remove: (id: string) => api<void>(`/organizations/${id}`, { method: 'DELETE' }),
};

export const devices = {
  list: () => api<Device[]>('/devices'),
  get: (id: string) => api<Device>(`/devices/${id}`),
  create: (data: Partial<Device> & { name: string; deviceKey: string; ipAddress: string }) =>
    api<Device>('/devices', { body: data }),
  update: (id: string, data: Partial<Device>) =>
    api<Device>(`/devices/${id}`, { method: 'PATCH', body: data }),
  remove: (id: string) => api<void>(`/devices/${id}`, { method: 'DELETE' }),
  ping: (id: string) => api<{ ok: boolean; info: unknown }>(`/devices/${id}/ping`, { method: 'POST' }),
  status: (id: string) => api<DeviceStatus>(`/devices/${id}/status`),
  setBrightness: (id: string, brightness: number) =>
    api<{ ok: boolean }>(`/devices/${id}/brightness`, { body: { brightness } }),
  reboot: (id: string) => api<{ ok: boolean }>(`/devices/${id}/reboot`, { method: 'POST' }),
  stop: (id: string) => api<{ ok: boolean }>(`/devices/${id}/stop`, { method: 'POST' }),
  /** Re-publish the device's base program (base playlist + overlay widgets). */
  republishBase: (id: string) => api<{ ok: boolean }>(`/devices/${id}/republish-base`, { body: {} }),
  bulkImport: (rows: Array<{
    name: string;
    latitude?: number | null;
    longitude?: number | null;
    location?: string | null;
    trafficStat?: string | null;
    description?: string | null;
    photos?: string[];
  }>) =>
    api<{
      matched: number;
      unmatched: number;
      errors: number;
      matchedRows: { name: string; id: string }[];
      unmatchedRows: string[];
      errorRows: { name: string; error: string }[];
    }>('/devices/bulk-import', { body: { rows } }),
};

export const media = {
  list: () => api<Media[]>('/media'),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api<Media>('/media', { formData: fd });
  },
  remove: (id: string) => api<void>(`/media/${id}`, { method: 'DELETE' }),
  backfillThumbnails: () =>
    api<{ candidates: number; generated: number; skipped: number; errors: { id: string; message: string }[] }>(
      '/media/backfill-thumbnails',
      { method: 'POST' },
    ),
};

export const playlists = {
  list: () => api<Playlist[]>('/playlists'),
  get: (id: string) => api<Playlist>(`/playlists/${id}`),
  create: (data: { name: string; description?: string; loop?: boolean; items: { mediaId: string; durationMs?: number }[] }) =>
    api<Playlist>('/playlists', { body: data }),
  update: (id: string, data: Omit<Partial<Playlist>, 'items'> & { items?: { mediaId: string; durationMs?: number }[] }) =>
    api<Playlist>(`/playlists/${id}`, { method: 'PATCH', body: data }),
  remove: (id: string) => api<void>(`/playlists/${id}`, { method: 'DELETE' }),
  deploy: (id: string, deviceId: string) =>
    api<{ ok: boolean }>(`/playlists/${id}/deploy`, { body: { deviceId } }),
};

export const publicRentals = {
  listDisplays: () => api<RentableDisplay[]>('/public/displays'),
  getDisplay: (id: string) => api<RentableDisplayDetail>(`/public/displays/${id}`),
  create: (data: {
    deviceId: string;
    advertiserName: string;
    advertiserEmail: string;
    advertiserPhone?: string;
    advertiserBusiness?: string;
    advertiserNotes?: string;
    startDate: string;
    durationUnit: 'day' | 'week' | 'month';
    durationCount: number;
  }) => api<CreateRentalResponse>('/public/rentals', { body: data }),
  uploadArtwork: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api<ArtworkUploadResponse>(`/public/rentals/${id}/artwork`, { formData: fd });
  },
  pay: (id: string, token: string, cardBrand?: string, cardLast4?: string) =>
    api<{ ok: boolean; chargeId: string; status: string }>(`/public/rentals/${id}/pay`, {
      body: { token, cardBrand, cardLast4 },
    }),
  status: (id: string) => api<PublicRentalStatus>(`/public/rentals/${id}`),
};

export const rentals = {
  list: (status?: string) => api<AdminRental[]>(`/rentals${status ? `?status=${status}` : ''}`),
  get: (id: string) => api<AdminRental>(`/rentals/${id}`),
  markPaid: (id: string, reference: string, provider = 'manual') =>
    api<{ id: string; status: string }>(`/rentals/${id}/mark-paid`, { body: { reference, provider } }),
  approve: (id: string, opts?: { notes?: string; startDate?: string }) =>
    api<AdminRental>(`/rentals/${id}/approve`, { body: opts ?? {} }),
  reject: (id: string, notes?: string) =>
    api<AdminRental>(`/rentals/${id}/reject`, { body: { notes } }),
  republish: (id: string) => api<AdminRental>(`/rentals/${id}/republish`, { body: {} }),
  getClientTrust: (id: string) =>
    api<{ clientId: number | null; trust: boolean | null }>(`/rentals/${id}/client-trust`),
  setClientTrust: (id: string, trust: boolean) =>
    api<{ clientId: number; trust: boolean }>(`/rentals/${id}/client-trust`, { body: { trust } }),
};

export interface ClientHit {
  id: number;
  email: string | null;
  company: string | null;
  name: string;
}

export interface ClientFull {
  id: number;
  email: string;
  company: string | null;
  name: string;
  trust_self_serve_ads: boolean;
}

export const clients = {
  search: (q: string) => api<{ clients: ClientHit[] }>(`/clients/search?q=${encodeURIComponent(q)}`),
  get: (id: number) => api<ClientFull>(`/clients/${id}`),
};

export interface AdContractRental {
  id: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  start_time: string;
  end_time: string;
  amount_cents: number;
  currency: string;
  advertiser_name: string;
  media_id: string | null;
  created_at: string;
  artwork_url: string | null;
  artwork_mime: string | null;
}

export interface AdContract {
  id: string;
  client_id: number;
  device_id: string;
  contract_type: 'rental' | 'owner_perpetual';
  status: 'active' | 'expired' | 'cancelled';
  start_date: string;
  end_date: string | null;
  term_unit: 'day' | 'week' | 'month' | 'year' | null;
  term_count: number | null;
  amount_cents: number | null;
  currency: string;
  auto_renew: boolean;
  renewal_invoice_id: string | null;
  renewal_invoiced_at: string | null;
  billing_contact_email: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  device_name?: string;
  device_location?: string | null;
  rental_count?: number;
  rentals?: AdContractRental[];
}

export interface CreateAdContractBody {
  clientId: number;
  deviceId: string;
  contractType?: 'rental' | 'owner_perpetual';
  startDate?: string;
  endDate?: string;
  termUnit?: 'day' | 'week' | 'month' | 'year';
  termCount?: number;
  amountCents?: number;
  currency?: string;
  autoRenew?: boolean;
  billingContactEmail?: string;
  notes?: string;
  attachRentalIds?: string[];
}

export interface UnattachedRental {
  id: string;
  status: string;
  advertiser_name: string;
  advertiser_email: string;
  advertiser_business: string | null;
  start_date: string | null;
  end_date: string | null;
  start_time: string;
  end_time: string;
  amount_cents: number;
  currency: string;
  duration_unit: string;
  duration_count: number;
  created_at: string;
  media_id: string | null;
  artwork_url: string | null;
  artwork_mime: string | null;
}

export interface UpdateAdContractBody {
  startDate?: string;
  endDate?: string | null;
  termUnit?: 'day' | 'week' | 'month' | 'year' | null;
  termCount?: number | null;
  amountCents?: number | null;
  currency?: string;
  autoRenew?: boolean;
  billingContactEmail?: string | null;
  notes?: string | null;
  status?: 'active' | 'expired' | 'cancelled';
}

export const adContracts = {
  list: (params: { deviceId?: string; clientId?: number; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.deviceId) q.set('deviceId', params.deviceId);
    if (params.clientId !== undefined) q.set('clientId', String(params.clientId));
    if (params.status) q.set('status', params.status);
    const qs = q.toString();
    return api<AdContract[]>(`/ad-contracts${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => api<AdContract>(`/ad-contracts/${id}`),
  create: (body: CreateAdContractBody) => api<AdContract>('/ad-contracts', { body }),
  update: (id: string, body: UpdateAdContractBody) =>
    api<AdContract>(`/ad-contracts/${id}`, { method: 'PATCH', body }),
  cancel: (id: string) => api<void>(`/ad-contracts/${id}`, { method: 'DELETE' }),
  attachRental: (contractId: string, rentalId: string) =>
    api<{ ok: true }>(`/ad-contracts/${contractId}/attach-rental`, { body: { rentalId } }),
  detachRental: (contractId: string, rentalId: string) =>
    api<void>(`/ad-contracts/${contractId}/detach-rental`, { body: { rentalId } }),
  unattachedRentals: (deviceId: string) =>
    api<UnattachedRental[]>(`/ad-contracts/unattached-rentals/${deviceId}`),
  attachMedia: (contractId: string, mediaId: string, advertiserName?: string) =>
    api<{ rentalId: string }>(`/ad-contracts/${contractId}/attach-media`, { body: { mediaId, advertiserName } }),
};

export const logs = {
  list: (params: { deviceId?: string; level?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.deviceId) q.set('deviceId', params.deviceId);
    if (params.level) q.set('level', params.level);
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return api<LogEntry[]>(`/logs${qs ? `?${qs}` : ''}`);
  },
};
