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
  approve: (id: string, notes?: string) =>
    api<AdminRental>(`/rentals/${id}/approve`, { body: { notes } }),
  reject: (id: string, notes?: string) =>
    api<AdminRental>(`/rentals/${id}/reject`, { body: { notes } }),
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
