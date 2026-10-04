import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from './http';
import type {
  Address, AdminBooking, AdminEvent, AdminMembership, AdminOverview, AdminRequest, Attention, Booking, BookingEvent, Catalog, Membership,
  MembershipRequest, MembershipWash, Notification, Order, PatternItem, Photo, PoolWash, PriceEstimate, RequestStatus, SlotId, Specialist, User, Vehicle, VehicleType, WorkerWash,
} from './types';

export const keys = {
  me: ['me'] as const,
  catalog: ['catalog'] as const,
  addresses: ['addresses'] as const,
  vehicles: ['vehicles'] as const,
  requests: ['membership-requests'] as const,
  request: (id: string) => ['membership-request', id] as const,
  memberships: ['memberships'] as const,
  membership: (id: string) => ['membership', id] as const,
  bookings: (scope: string) => ['bookings', scope] as const,
  booking: (id: string) => ['booking', id] as const,
  photos: (id: string) => ['photos', id] as const,
  notifications: ['notifications'] as const,
  workerQueue: ['worker-queue'] as const,
  workerPool: ['worker-pool'] as const,
  admin: (...p: unknown[]) => ['admin', ...p] as const,
};

// ───────── session ─────────
export const fetchMe = async () => (await get<{ user: User }>('/me')).user;
export const useMe = () => useQuery({ queryKey: keys.me, queryFn: fetchMe, retry: false, staleTime: 60_000 });

export const useCatalog = () => useQuery({ queryKey: keys.catalog, queryFn: () => get<Catalog>('/catalog'), staleTime: 5 * 60_000 });

export interface EstimateInput {
  vehicle_type: VehicleType;
  weekly_pattern: PatternItem[];
  duration_months: number;
}

/** Live price estimate from the rate card (the database runs the calculator). Null input = nothing to price yet. */
export const useEstimate = (input: EstimateInput | null) =>
  useQuery({
    queryKey: ['estimate', input],
    queryFn: async () => (await post<{ estimate: PriceEstimate }>('/membership-estimate', input)).estimate,
    enabled: Boolean(input),
    staleTime: 10 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });

/** The mix a plan starts from before the customer chooses: bikes all one wash, otherwise Body, Deep, Body, Deep... */
export function defaultPattern(vehicleType: VehicleType, perWeek: number): PatternItem[] {
  return Array.from({ length: perWeek }, (_, i) => ({ weekday: i, kind: vehicleType === 'bike' || i % 2 === 0 ? 'body' : 'deep' }));
}

// ───────── customer reads ─────────
export const useAddresses = () => useQuery({ queryKey: keys.addresses, queryFn: async () => (await get<{ addresses: Address[] }>('/addresses')).addresses });
export const useVehicles = () => useQuery({ queryKey: keys.vehicles, queryFn: async () => (await get<{ vehicles: Vehicle[] }>('/vehicles')).vehicles });

export const useRequests = () =>
  useQuery({ queryKey: keys.requests, queryFn: async () => (await get<{ requests: MembershipRequest[] }>('/membership-requests')).requests });

export const useRequest = (id: string | undefined) =>
  useQuery({
    queryKey: keys.request(id ?? ''),
    queryFn: async () => (await get<{ request: MembershipRequest }>(`/membership-requests/${id}`)).request,
    enabled: Boolean(id),
    // While WASHO is reviewing, check back so the price appears without a manual refresh.
    refetchInterval: (q) => (q.state.data?.status === 'submitted' ? 15_000 : false),
  });

export const useMemberships = () =>
  useQuery({ queryKey: keys.memberships, queryFn: async () => (await get<{ memberships: Membership[] }>('/memberships')).memberships });

export const useMembership = (id: string | undefined) =>
  useQuery({
    queryKey: keys.membership(id ?? ''),
    queryFn: () => get<{ membership: Membership; washes: MembershipWash[] }>(`/memberships/${id}`),
    enabled: Boolean(id),
  });

export const useBookings = (scope: 'upcoming' | 'past' | 'all' = 'all') =>
  useQuery({ queryKey: keys.bookings(scope), queryFn: async () => (await get<{ bookings: Booking[] }>(`/bookings?scope=${scope}`)).bookings });

export const useBooking = (id: string | undefined) =>
  useQuery({
    queryKey: keys.booking(id ?? ''),
    queryFn: () => get<{ booking: Booking; events: BookingEvent[] }>(`/bookings/${id}`),
    enabled: Boolean(id),
  });

export const usePhotos = (bookingId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: keys.photos(bookingId ?? ''),
    queryFn: async () => (await get<{ photos: Photo[] }>(`/bookings/${bookingId}/photos`)).photos,
    enabled: Boolean(bookingId) && enabled,
    // Signed links are short-lived; refresh before they lapse.
    staleTime: 5 * 60_000,
  });

export const useNotifications = () =>
  useQuery({ queryKey: keys.notifications, queryFn: async () => (await get<{ notifications: Notification[] }>('/notifications')).notifications });

/** Anything about a wash, a request or a payment changed: refresh every view that could show it. */
export function useRefreshAll() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      ['membership-requests', 'membership-request', 'memberships', 'membership', 'bookings', 'booking', 'photos', 'notifications', 'worker-queue', 'worker-pool', 'admin'].map((k) =>
        qc.invalidateQueries({ queryKey: [k] })
      )
    );
}

// ───────── customer writes ─────────
export const useSaveProfile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { full_name: string; email: string }) => (await put<{ user: User }>('/me', body)).user,
    onSuccess: (user) => qc.setQueryData(keys.me, user),
  });
};

export type AddressInput = Omit<Address, 'id' | 'is_default'> & { is_default?: boolean };

export const useSaveAddress = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: Partial<AddressInput> & { id?: string }) =>
      (await (id ? put<{ address: Address }>(`/addresses/${id}`, body) : post<{ address: Address }>('/addresses', body))).address,
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.addresses }),
  });
};

export interface VehicleInput {
  vehicle_type: VehicleType;
  make?: string;
  model: string;
  registration_number: string;
  color?: string;
  address_id?: string | null;
  parking_location?: string;
}

export const useSaveVehicle = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: VehicleInput & { id?: string }) =>
      (await (id ? put<{ vehicle: Vehicle }>(`/vehicles/${id}`, body) : post<{ vehicle: Vehicle }>('/vehicles', body))).vehicle,
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.vehicles }),
  });
};

export const useDeleteVehicle = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => del(`/vehicles/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: keys.vehicles }) });
};

export interface MembershipRequestInput {
  vehicle_id: string;
  weekly_pattern: PatternItem[];
  duration_months: number;
  time_slot: SlotId;
  start_date: string;
  address_id?: string | null;
  parking_location?: string;
  customer_notes?: string;
}

export const useCreateRequest = () => {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (body: MembershipRequestInput) => post<{ id: string; reference_code: string }>('/membership-requests', body),
    onSuccess: () => refresh(),
  });
};

export const useAcceptQuote = () => useMutation({ mutationFn: async (id: string) => (await post<{ order: Order }>(`/membership-requests/${id}/accept`)).order });

export const useDeclineQuote = () => {
  const refresh = useRefreshAll();
  return useMutation({ mutationFn: (id: string) => post(`/membership-requests/${id}/decline`), onSuccess: () => refresh() });
};

export interface OnDemandInput {
  vehicle_id: string;
  service_id: string;
  scheduled_date: string;
  time_slot: SlotId;
  address_id?: string | null;
  parking_location?: string;
}

export const useStartOnDemandPayment = () =>
  useMutation({ mutationFn: async (body: OnDemandInput) => (await post<{ order: Order }>('/payments/on-demand', body)).order });

export const useCancelBooking = () => {
  const refresh = useRefreshAll();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason?: string }) => post(`/bookings/${id}/cancel`, { reason }), onSuccess: () => refresh() });
};

export const useRescheduleWash = () => {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ id, date, time_slot }: { id: string; date: string; time_slot: SlotId }) => post(`/bookings/${id}/reschedule`, { date, time_slot }),
    onSuccess: () => refresh(),
  });
};

// ───────── worker ─────────
export const useWorkerQueue = () =>
  useQuery({
    queryKey: keys.workerQueue,
    queryFn: async () => (await get<{ queue: WorkerWash[] }>('/worker/queue?days=14')).queue,
    // The queue changes while the specialist is out (moves, cancellations, new assignments).
    refetchInterval: 60_000,
  });

export const useWorkerPool = (enabled = true) =>
  useQuery({ queryKey: keys.workerPool, queryFn: async () => (await get<{ pool: PoolWash[] }>('/worker/pool')).pool, enabled });

export type WorkerStep = 'claim' | 'call' | 'confirm' | 'not-picked-up' | 'start' | 'complete' | 'issue' | 'note';

export const useWorkerStep = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, step, body }: { id: string; step: WorkerStep; body?: Record<string, unknown> }) =>
      (await post<{ wash: WorkerWash | null }>(`/worker/washes/${id}/${step}`, body)).wash,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.workerQueue });
      qc.invalidateQueries({ queryKey: keys.workerPool });
    },
  });
};

/** Sends one photo as raw bytes. The server checks the specialist holds the wash before it stores anything. */
export async function uploadWashPhoto(bookingId: string, phase: 'before' | 'after', type: string, blob: Blob): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/bookings/${bookingId}/photos?phase=${phase}&type=${type}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
    });
  } catch {
    throw new Error("We couldn't reach WASHO. Check your connection and try again.");
  }
  if (!res.ok) {
    let message = 'The photo could not be saved. Please try again.';
    try {
      message = (await res.json()).message ?? message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
}

// ───────── admin ─────────
export const useAdminOverview = () => useQuery({ queryKey: keys.admin('overview'), queryFn: async () => (await get<{ overview: AdminOverview }>('/admin/overview')).overview, refetchInterval: 60_000 });

export const useAdminRequests = (status?: RequestStatus) =>
  useQuery({
    queryKey: keys.admin('requests', status ?? 'all'),
    queryFn: async () => (await get<{ requests: AdminRequest[] }>(`/admin/membership-requests${status ? `?status=${status}` : ''}`)).requests,
  });

export const useReviewRequest = () => {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; action: 'quote' | 'reject'; adjustment_cents?: number; adjustment_reason?: string; rejection_reason?: string }) =>
      post(`/admin/membership-requests/${id}/review`, body),
    onSuccess: () => refresh(),
  });
};

export interface AdminBookingFilter {
  from?: string;
  to?: string;
  status?: string;
  worker?: string;
  unassigned?: boolean;
  membership?: string;
}

export const useAdminBookings = (f: AdminBookingFilter) => {
  const q = new URLSearchParams();
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (f.status) q.set('status', f.status);
  if (f.worker) q.set('worker', f.worker);
  if (f.unassigned) q.set('unassigned', '1');
  if (f.membership) q.set('membership', f.membership);
  return useQuery({ queryKey: keys.admin('bookings', q.toString()), queryFn: async () => (await get<{ bookings: AdminBooking[] }>(`/admin/bookings?${q}`)).bookings });
};

export const useAdminBooking = (id: string | undefined) =>
  useQuery({
    queryKey: keys.admin('booking', id ?? ''),
    queryFn: () => get<{ booking: AdminBooking; events: AdminEvent[]; photos: Photo[] }>(`/admin/bookings/${id}`),
    enabled: Boolean(id),
  });

export const useAdminMemberships = () => useQuery({ queryKey: keys.admin('memberships'), queryFn: async () => (await get<{ memberships: AdminMembership[] }>('/admin/memberships')).memberships });
export const useAdminWorkers = () => useQuery({ queryKey: keys.admin('workers'), queryFn: async () => (await get<{ workers: Specialist[] }>('/admin/workers')).workers });
export const useAdminAttention = () => useQuery({ queryKey: keys.admin('attention'), queryFn: () => get<{ success: boolean } & Attention>('/admin/attention') });

export const useAdminAction = () => {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: Record<string, unknown> }) => post(`/admin/${path}`, body ?? {}),
    onSuccess: () => refresh(),
  });
};
