import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from './http';
import { isLive } from './status';
import type {
  Address, AdminAddress, AdminBooking, AdminCampaign, AdminCampaignClaim, AdminHistorySummary, AdminCustomerDetail, AdminCustomerRow, AdminEvent, AdminPricing, AdminService, AdminMembership, AdminOverview, AdminRequest, Attention, Booking, BookingEvent, BookingRefund, Catalog, Membership,
  CampaignStatus, MembershipRequest, MembershipWash, Notification, Order, PatternItem, Photo, PoolWash, PriceEstimate, RequestStatus, SlotId, Specialist, User, Vehicle, VehicleType, WorkerWash,
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
  campaign: ['campaign'] as const,
  workerQueue: ['worker-queue'] as const,
  workerPool: ['worker-pool'] as const,
  admin: (...p: unknown[]) => ['admin', ...p] as const,
};

// ───────── session ─────────
export const fetchMe = async () => (await get<{ user: User }>('/me')).user;
export const useMe = () => useQuery({ queryKey: keys.me, queryFn: fetchMe, retry: false, staleTime: 60_000 });

export const useCatalog = () => useQuery({ queryKey: keys.catalog, queryFn: () => get<Catalog>('/catalog'), staleTime: 5 * 60_000 });

/** The free-wash campaign on offer, what this visitor can do about it, and their pack offer. Open to visitors (no sign-in needed). */
export const useCampaign = () => useQuery({ queryKey: keys.campaign, queryFn: () => get<CampaignStatus>('/campaign'), staleTime: 30_000, retry: false, refetchOnMount: 'always' });

export interface EstimateInput {
  vehicle_type: VehicleType;
  weekly_pattern: PatternItem[];
  duration_months: number;
}

/** Live price estimate from the rate card (the database runs the calculator). Null input = nothing to price yet. */
export const useEstimate = (input: EstimateInput | null) => {
  // The price can include this customer's welcome offer, so it is cached per offer.
  const offer = useCampaign().data?.offer?.claim_id ?? null;
  return useQuery({
    queryKey: ['estimate', input, offer],
    queryFn: async () => (await post<{ estimate: PriceEstimate }>('/membership-estimate', input)).estimate,
    enabled: Boolean(input),
    staleTime: 10 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
};

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

/** `live`: check again every 30 seconds while the page is open, so a wash the specialist has just finished shows up without a refresh. */
export const useBookings = (scope: 'upcoming' | 'past' | 'all' = 'all', live = false) =>
  useQuery({
    queryKey: keys.bookings(scope),
    queryFn: async () => (await get<{ bookings: Booking[] }>(`/bookings?scope=${scope}`)).bookings,
    refetchInterval: live ? 30_000 : false,
  });

export const useBooking = (id: string | undefined) =>
  useQuery({
    queryKey: keys.booking(id ?? ''),
    queryFn: () => get<{ booking: Booking; events: BookingEvent[]; refund: BookingRefund | null }>(`/bookings/${id}`),
    enabled: Boolean(id),
    // While the wash is being done, follow it: assigned, called, started, completed (and its photos).
    refetchInterval: (q) => (q.state.data && isLive(q.state.data.booking.status) ? 15_000 : false),
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
      ['membership-requests', 'membership-request', 'memberships', 'membership', 'bookings', 'booking', 'photos', 'notifications', 'worker-queue', 'worker-pool', 'admin', 'catalog', 'addresses', 'vehicles', 'campaign', 'estimate'].map((k) =>
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

/** Pay for a custom membership straight away: the server prices it from the rate card and opens the Razorpay order. */
export const useStartMembershipPayment = () =>
  useMutation({ mutationFn: async (body: MembershipRequestInput) => (await post<{ order: Order }>('/payments/membership-checkout', body)).order });

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

export interface ClaimInput { campaign_id: string; vehicle_id: string; date: string; time_slot: SlotId; address_id?: string | null; parking_location?: string }
/** Claim the free wash: books it in one step (the database checks every rule). */
export const useClaimFreeWash = () => {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (body: ClaimInput) => post<{ booking_id: string; claim_id: string; campaign_name: string; service_name: string }>('/campaign/claim', body),
    onSuccess: () => refresh(),
  });
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
      // logging a call is sent with keepalive: the phone goes to its dialer straight after the tap
      (await post<{ wash: WorkerWash | null }>(`/worker/washes/${id}/${step}`, body, step === 'call' ? { keepalive: true } : undefined)).wash,
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

export interface AdminHistoryFilter {
  from: string;
  to: string;
  status?: string;
  worker?: string;
  q?: string;
}

const HISTORY_PAGE = 50;

/** Past washes, newest first, 50 at a time, with the totals for the same filter. */
export const useAdminHistory = (f: AdminHistoryFilter) =>
  useInfiniteQuery({
    queryKey: keys.admin('history', f.from, f.to, f.status ?? '', f.worker ?? '', f.q ?? ''),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ from: f.from, to: f.to, limit: String(HISTORY_PAGE), offset: String(pageParam) });
      if (f.status) q.set('status', f.status);
      if (f.worker) q.set('worker', f.worker);
      if (f.q) q.set('q', f.q);
      return get<{ bookings: AdminBooking[]; summary: AdminHistorySummary }>(`/admin/history?${q}`);
    },
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.bookings.length, 0);
      return loaded < last.summary.total && last.bookings.length > 0 ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
  });

export const useAdminBooking = (id: string | undefined) =>
  useQuery({
    queryKey: keys.admin('booking', id ?? ''),
    queryFn: () => get<{ booking: AdminBooking; events: AdminEvent[]; photos: Photo[] }>(`/admin/bookings/${id}`),
    enabled: Boolean(id),
  });

export const useAdminMemberships = () => useQuery({ queryKey: keys.admin('memberships'), queryFn: async () => (await get<{ memberships: AdminMembership[] }>('/admin/memberships')).memberships });
export const useAdminWorkers = (status: 'active' | 'archived' | 'all' = 'active') =>
  useQuery({ queryKey: keys.admin('workers', status), queryFn: async () => (await get<{ workers: Specialist[] }>(`/admin/workers?status=${status}`)).workers });
export const useAdminCustomers = (q: string, status: 'active' | 'archived' | 'all') =>
  useQuery({ queryKey: keys.admin('customers', q, status), queryFn: async () => (await get<{ customers: AdminCustomerRow[] }>(`/admin/customers?q=${encodeURIComponent(q)}&status=${status}`)).customers });
export const useAdminCustomer = (id: string | undefined) =>
  useQuery({ queryKey: keys.admin('customer', id ?? ''), queryFn: () => get<AdminCustomerDetail>(`/admin/customers/${id}`), enabled: Boolean(id) });
export const useAdminCampaigns = () => useQuery({ queryKey: keys.admin('campaigns'), queryFn: async () => (await get<{ campaigns: AdminCampaign[] }>('/admin/campaigns')).campaigns });
export const useAdminCampaign = (id: string | undefined) =>
  useQuery({ queryKey: keys.admin('campaign', id ?? ''), queryFn: () => get<{ campaign: AdminCampaign; days: { date: string; washes: number }[] }>(`/admin/campaigns/${id}`), enabled: Boolean(id) });
export const useAdminCampaignClaims = (id: string | undefined, status: string, q: string) =>
  useQuery({
    queryKey: keys.admin('campaign-claims', id ?? '', status, q),
    queryFn: async () => (await get<{ claims: AdminCampaignClaim[] }>(`/admin/campaigns/${id}/claims?status=${status}&q=${encodeURIComponent(q)}`)).claims,
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
export const useAdminServices = () => useQuery({ queryKey: keys.admin('services'), queryFn: async () => (await get<{ services: AdminService[] }>('/admin/services')).services });
export const useAdminPricing = () => useQuery({ queryKey: keys.admin('pricing'), queryFn: () => get<AdminPricing>('/admin/pricing') });
export type { AdminAddress };
export const useAdminAttention = () => useQuery({ queryKey: keys.admin('attention'), queryFn: () => get<{ success: boolean } & Attention>('/admin/attention') });

/** Any admin write. POST by default; PUT for edits. Refreshes every admin view (and the public catalogue, in case a price or service changed). */
export const useAdminAction = () => {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ path, body, method = 'POST' }: { path: string; body?: Record<string, unknown>; method?: 'POST' | 'PUT' }) =>
      method === 'PUT' ? put<Record<string, any>>(`/admin/${path}`, body ?? {}) : post<Record<string, any>>(`/admin/${path}`, body ?? {}),
    onSuccess: () => refresh(),
  });
};
