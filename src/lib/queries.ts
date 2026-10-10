import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from './http';
import { isLive } from './status';
import type {
  ActivityEvent, Address, AdminAddress, AdminBooking, AdminCoupon, AdminDashboard, AdminRenewals, AdminReviews, CouponUse, WashReview, AdminSecurity, AdminSettings, AdminSupportTicket, PublicSettings, SupportThread, SupportTicket, TeamMember, TicketStatus, AdminCampaign, CapacityDay, CapacityRule, ExactDate, PlanPreview, AdminCampaignClaim, AdminHistorySummary, AdminCustomerDetail, AdminCustomerRow, AdminEvent, AdminPricing, AdminService, AdminMembership, AdminOverview, AdminRequest, Attention, Booking, BookingEvent, BookingRefund, Catalog, Membership,
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

/** How crowded each day and time window is, by date. Marks busy days amber and rush days red (never closed) on the booking pages. */
export const useCapacity = (from: string, to: string, enabled = true) =>
  useQuery({
    queryKey: ['capacity', from, to],
    queryFn: async () => Object.fromEntries((await get<{ days: CapacityDay[] }>(`/capacity?from=${from}&to=${to}`)).days.map((d) => [d.date, d])) as Record<string, CapacityDay>,
    staleTime: 30_000,
    enabled,
    retry: false,
  });

/** The washes in a month (4 to 28, any mix) and the weekdays the customer likes. */
export interface MonthlyPlan { body: number; deep: number; weekdays?: number[] }
export type PreviewInput = { vehicle_id: string; duration_months: number; time_slot: SlotId; start_date: string } & ({ weekly_pattern: PatternItem[]; monthly?: never } | { monthly: MonthlyPlan; weekly_pattern?: never });
/** Where a plan lands on the calendar before paying (the database lays it out the way the payment will). */
export const usePlanPreview = (input: PreviewInput | null) =>
  useQuery({ queryKey: ['plan-preview', input], queryFn: () => post<PlanPreview & { success: boolean }>('/membership-preview', input), enabled: Boolean(input), staleTime: 30_000, retry: false, placeholderData: keepPreviousData });

export type EstimateInput = { vehicle_type: VehicleType; duration_months: number; /** a coupon the customer typed (washes-in-a-month plans, signed in) */ coupon?: string } & ({ weekly_pattern: PatternItem[]; monthly?: never } | { monthly: { body: number; deep: number }; weekly_pattern?: never });

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
      ['membership-requests', 'membership-request', 'memberships', 'membership', 'bookings', 'booking', 'photos', 'notifications', 'worker-queue', 'worker-pool', 'admin', 'catalog', 'addresses', 'vehicles', 'campaign', 'estimate', 'capacity', 'plan-preview'].map((k) =>
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

export type MembershipRequestInput = {
  vehicle_id: string;
  duration_months: number;
  time_slot: SlotId;
  start_date: string;
  address_id?: string | null;
  parking_location?: string;
  customer_notes?: string;
  /** Exact dates for every wash, instead of letting the plan land on its weekdays. */
  custom_dates?: ExactDate[];
  /** A coupon the customer typed on the last step (washes-in-a-month plans). */
  coupon?: string;
} & ({ weekly_pattern: PatternItem[]; monthly?: never } | { monthly: MonthlyPlan; weekly_pattern?: never });

/** Pay for a custom membership straight away: the server prices it from the rate card and opens the Razorpay order. */
export const useStartMembershipPayment = () =>
  useMutation({ mutationFn: async (body: MembershipRequestInput) => (await post<{ order: Order }>('/payments/membership-checkout', body)).order });

export const useAcceptQuote = () => useMutation({ mutationFn: async (id: string) => (await post<{ order: Order }>(`/membership-requests/${id}/accept`)).order });

export const useDeclineQuote = () => {
  const refresh = useRefreshAll();
  return useMutation({ mutationFn: (id: string) => post(`/membership-requests/${id}/decline`), onSuccess: () => refresh() });
};

/** A single wash priced for this customer, with the coupon they typed if there is one. */
export interface SingleWashEstimate { list_cents: number; final_cents: number; coupon?: { id: string; code: string; bp: number; cents: number } }
export const useSingleWashEstimate = (input: { vehicle_id: string; service_id: string; coupon: string } | null) =>
  useQuery({
    queryKey: ['estimate', 'single', input],
    queryFn: async () => (await post<{ estimate: SingleWashEstimate }>('/booking-estimate', input)).estimate,
    enabled: Boolean(input),
    staleTime: 5 * 60_000,
    retry: false,
  });

export interface OnDemandInput {
  vehicle_id: string;
  service_id: string;
  scheduled_date: string;
  time_slot: SlotId;
  address_id?: string | null;
  parking_location?: string;
  /** A coupon the customer typed on the review step. */
  coupon?: string;
}

export const useStartOnDemandPayment = () =>
  useMutation({ mutationFn: async (body: OnDemandInput) => (await post<{ order: Order }>('/payments/on-demand', body)).order });

/** Rate a finished wash (1 to 5 stars), with or without a review; sending it again changes it. */
export const useRateWash = () => {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ id, rating, review }: { id: string; rating: number; review?: string }) => post<{ review: WashReview }>(`/bookings/${id}/review`, { rating, review: review?.trim() || null }),
    onSuccess: () => refresh(),
  });
};

/** Clear a finished wash from the customer's own Washes tab (nothing is deleted), or bring it back. */
export const useHideWash = () => {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ id, undo = false }: { id: string; undo?: boolean }) => post(`/bookings/${id}/${undo ? 'unhide' : 'hide'}`, {}),
    onSuccess: () => refresh(),
  });
};

export const useCancelBooking = () => {
  const refresh = useRefreshAll();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason?: string }) => post(`/bookings/${id}/cancel`, { reason }), onSuccess: () => refresh() });
};

export interface ClaimInput { campaign_id: string; vehicle_id: string; address_id?: string | null; parking_location?: string } // no date or time: WASHO picks them
/** Claim the free wash: books it in one step (the database checks every rule). */
export const useClaimFreeWash = () => {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (body: ClaimInput) => post<{ booking_id: string; claim_id: string; campaign_name: string; service_name: string; scheduled_date?: string; time_slot?: SlotId }>('/campaign/claim', body),
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

/** Clears a plan from the customer's own pages: one started but not paid for, or one that has ended. Nothing is deleted. */
export const useRemovePlan = () => {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ kind, id }: { kind: 'membership' | 'request'; id: string }) =>
      post<{ removed: boolean; stopped_checkout: boolean }>(kind === 'membership' ? `/memberships/${id}/remove` : `/membership-requests/${id}/remove`, {}),
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

export type WorkerStep = 'claim' | 'call' | 'confirm' | 'not-picked-up' | 'reschedule' | 'start' | 'complete' | 'issue' | 'note';

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
    queryFn: () => get<{ booking: AdminBooking; events: AdminEvent[]; photos: Photo[]; review: WashReview | null }>(`/admin/bookings/${id}`),
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
export const useAdminCapacity = (from: string, to: string) =>
  useQuery({ queryKey: keys.admin('capacity', from, to), queryFn: () => get<{ rules: CapacityRule[]; days: CapacityDay[] }>(`/admin/capacity?from=${from}&to=${to}`) });
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


// ───────── back-office ─────────
export const useAdminDashboard = () => useQuery({ queryKey: keys.admin('dashboard'), queryFn: async () => (await get<{ dashboard: AdminDashboard }>('/admin/dashboard')).dashboard, refetchInterval: 60_000 });

export const useAdminActivity = (q: string, limit: number) =>
  useQuery({ queryKey: keys.admin('activity', q, limit), queryFn: async () => (await get<{ events: ActivityEvent[] }>(`/admin/activity?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`)).events, placeholderData: keepPreviousData });

export const useAdminSupport = (status: TicketStatus | 'all') =>
  useQuery({ queryKey: keys.admin('support', status), queryFn: async () => (await get<{ tickets: AdminSupportTicket[] }>(`/admin/support?status=${status}`)).tickets, refetchInterval: 60_000 });
export const useAdminSupportTicket = (id: string | null) =>
  useQuery({ queryKey: keys.admin('support-ticket', id), queryFn: () => get<SupportThread & { success: boolean }>(`/admin/support/${id}`), enabled: Boolean(id) });

export const useAdminSettings = () => useQuery({ queryKey: keys.admin('settings'), queryFn: () => get<{ settings: AdminSettings; security: AdminSecurity }>('/admin/settings') });
export const useAdminRenewals = () => useQuery({ queryKey: keys.admin('renewals'), queryFn: () => get<AdminRenewals & { success: boolean }>('/admin/renewals') });
export const useAdminCoupons = () => useQuery({ queryKey: keys.admin('coupons'), queryFn: async () => (await get<{ coupons: AdminCoupon[] }>('/admin/coupons')).coupons });
export const useAdminCouponUses = (id: string | null) => useQuery({ queryKey: keys.admin('coupon-uses', id), queryFn: async () => (await get<{ uses: CouponUse[] }>(`/admin/coupons/${id}/uses`)).uses, enabled: Boolean(id) });
export const useAdminReviews = (max: number | null) => useQuery({ queryKey: keys.admin('reviews', max), queryFn: async () => { const { summary, reviews } = await get<AdminReviews & { success: boolean }>(`/admin/reviews${max ? `?max=${max}` : ''}`); return { summary, reviews } as AdminReviews; } });
export const useAdminTeam = () => useQuery({ queryKey: keys.admin('team'), queryFn: async () => (await get<{ team: TeamMember[] }>('/admin/team')).team });

/** Is the site paused for maintenance? Anyone may ask. */
export const usePublicSettings = () =>
  useQuery({ queryKey: ['public-settings'], queryFn: async () => { const { maintenance_mode, maintenance_message } = await get<PublicSettings & { success: boolean }>('/settings'); return { maintenance_mode, maintenance_message } as PublicSettings; }, staleTime: 30_000, retry: false, refetchOnWindowFocus: true });

// ───────── a customer's complaints ─────────
export const keysSupport = { list: ['support'] as const, one: (id: string) => ['support', id] as const };
export const useMySupport = () => useQuery({ queryKey: keysSupport.list, queryFn: async () => (await get<{ tickets: SupportTicket[] }>('/support')).tickets });
export const useMySupportTicket = (id: string | undefined) => useQuery({ queryKey: keysSupport.one(id ?? ''), queryFn: () => get<SupportThread & { success: boolean }>(`/support/${id}`), enabled: Boolean(id) });
export const useCreateTicket = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { category: string; subject: string; message: string; booking_id?: string | null }) => post<{ ticket: { id: string; reference_code: string } }>('/support', b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keysSupport.list }),
  });
};
export const useReplyTicket = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => post(`/support/${id}/reply`, { message }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keysSupport.one(id) }); void qc.invalidateQueries({ queryKey: keysSupport.list }); },
  });
};
