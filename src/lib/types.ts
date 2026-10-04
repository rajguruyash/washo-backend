// Shapes returned by the WASHO website API. They mirror the Supabase database (snake_case), so there is no second
// naming scheme to keep in step.

export type VehicleType = 'bike' | 'car' | 'suv';
export type SlotId = 'morning' | 'afternoon' | 'night';
export type Role = 'customer' | 'worker' | 'admin';
export type WashKind = 'body' | 'deep';

export interface User {
  id: string;
  role: Role;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  needs_profile: boolean;
}

export interface Address {
  id: string;
  label: string;
  society_name: string;
  building_block: string;
  flat_number: string;
  parking_location: string;
  area_locality: string;
  city: string;
  pincode: string;
  is_default: boolean;
}

export interface Vehicle {
  id: string;
  vehicle_type: VehicleType;
  make: string | null;
  model: string;
  registration_number: string;
  color: string | null;
  address_id: string | null;
  parking_location: string | null;
}

// ───────── catalogue (all data from Supabase) ─────────
export interface CatalogService {
  id: string;
  code: string;
  name: string;
  description: string | null;
  tagline: string | null;
  vehicle_type: VehicleType;
  wash_kind: WashKind | null;
  duration_minutes: number | null;
  includes: string[] | null;
  unit_prices: { vehicle_type: VehicleType; price_cents: number }[] | null;
}

export interface Catalog {
  services: CatalogService[];
  membership_options: { vehicle_type: VehicleType; wash_kind: WashKind; service_code: string }[];
  discounts: { kind: 'frequency' | 'duration'; key: number; discount_bp: number; label: string }[];
  max_total_discount_bp: number;
  weeks_per_month: number;
}

// ───────── membership requests and quotes ─────────
export interface PatternItem {
  weekday: number;
  kind: WashKind;
}

export type RequestStatus = 'submitted' | 'quoted' | 'accepted' | 'active' | 'rejected' | 'declined' | 'expired' | 'cancelled';

export interface QuoteBreakdown {
  washes_total: number;
  lines: { name: string; kind: WashKind; per_week: number; quantity: number; unit_cents: number; line_cents: number }[];
  subtotal_cents: number;
  frequency_discount: { bp: number; cents: number; label: string | null };
  duration_discount: { bp: number; cents: number; label: string | null };
  cap: { max_bp: number; applied: boolean; adjustment_cents: number };
  total_discount_cents: number;
  adjustment: { cents: number; reason: string | null };
  final_cents: number;
}

export interface MembershipRequest {
  id: string;
  reference_code: string;
  status: RequestStatus;
  vehicle_id: string;
  vehicle_type: VehicleType;
  vehicle_make: string | null;
  vehicle_model: string;
  registration_number: string;
  frequency_per_week: number;
  duration_months: number;
  weekly_pattern: PatternItem[];
  time_slot: SlotId;
  start_date: string;
  customer_notes: string | null;
  // The database leaves these empty until WASHO has approved a price.
  quoted_amount_cents: number | null;
  quoted_breakdown: QuoteBreakdown | null;
  quote_expires_at: string | null;
  rejection_reason: string | null;
  payment_id: string | null;
  membership_id: string | null;
  created_at: string;
}

export interface Order {
  order_id: string;
  amount: number;
  currency: string;
  key_id: string;
  payment_id: string;
  prefill: { contact?: string; email?: string };
}

export interface VerifyResult {
  status: 'fulfilled' | 'already_settled' | 'unfulfilled' | string;
  booking_id?: string | null;
  membership_id?: string | null;
  message?: string;
}

// ───────── memberships and washes ─────────
export interface NextWash {
  id: string;
  scheduled_date: string;
  time_slot: SlotId;
  status: BookingStatus;
}

export interface Membership {
  id: string;
  status: 'active' | 'cancelled' | 'expired' | 'paused';
  duration_months: number;
  start_at: string;
  end_at: string;
  base_amount_cents: number;
  discount_amount_cents: number;
  final_amount_cents: number;
  reference_code: string | null;
  frequency_per_week: number | null;
  weekly_pattern: PatternItem[] | null;
  time_slot: SlotId | null;
  vehicle_id: string | null;
  vehicle_type: VehicleType | null;
  vehicle_model: string | null;
  registration_number: string | null;
  washes_total: number;
  washes_completed: number;
  next_wash: NextWash | null;
}

export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'worker_assigned'
  | 'worker_called'
  | 'call_not_picked_up'
  | 'in_progress'
  | 'completed'
  | 'rescheduled'
  | 'cancelled'
  | 'refund_requested'
  | 'refunded'
  | 'no_show';

export interface MembershipWash {
  id: string;
  reference_code: string;
  scheduled_date: string;
  time_slot: SlotId;
  status: BookingStatus;
  occurrence_id: string | null;
  service_name: string;
  wash_kind: WashKind | null;
}

export interface Booking {
  id: string;
  reference_code: string;
  status: BookingStatus;
  booking_type: 'on_demand' | 'membership';
  scheduled_date: string;
  time_slot: SlotId;
  membership_id: string | null;
  occurrence_id: string | null;
  price_cents: number | null;
  parking_location: string | null;
  target_completion_time: string | null;
  customer_confirmed_at: string | null;
  created_at: string;
  completed_at: string | null;
  cancel_reason: string | null;
  service_name: string;
  wash_kind: WashKind | null;
  vehicle_id: string;
  vehicle_type: VehicleType;
  vehicle_make: string | null;
  vehicle_model: string;
  registration_number: string;
}

export interface BookingEvent {
  event_type: string;
  created_at: string;
  meta: Record<string, any>;
}

export interface Photo {
  id: string;
  phase: 'before' | 'after';
  photo_type: 'front' | 'rear' | 'left' | 'right' | 'additional';
  created_at: string;
  url: string | null;
}

export interface Notification {
  id: string;
  category: string;
  title: string;
  body: string;
  reference_id: string | null;
  read: boolean;
  created_at: string;
}

// ───────── worker ─────────
export type WorkerBucket = 'today' | 'in_progress' | 'upcoming' | 'completed' | 'changed';

export interface WorkerWash {
  booking_id: string;
  reference_code: string;
  status: BookingStatus;
  bucket: WorkerBucket;
  is_overdue: boolean;
  booking_type: 'on_demand' | 'membership';
  scheduled_date: string;
  time_slot: SlotId;
  service_name: string;
  wash_kind: WashKind | null;
  vehicle_type: VehicleType;
  vehicle_make: string | null;
  vehicle_model: string | null;
  registration_number: string | null;
  vehicle_color: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  address_label: string | null;
  society_name: string | null;
  building_block: string | null;
  flat_number: string | null;
  area_locality: string | null;
  city: string | null;
  parking_location: string | null;
  instructions: string | null;
  target_completion_time: string | null;
  membership_id: string | null;
  membership_reference: string | null;
  membership_label: string | null;
  wash_number: number | null;
  washes_total: number | null;
  customer_confirmed_at: string | null;
  calls_made: number;
  last_call_at: string | null;
  photos_before: number;
  photos_after: number;
  started_at: string | null;
  completed_at: string | null;
  change: { kind: 'rescheduled' | 'cancelled' | 'reassigned'; at: string; from_date?: string; from_slot?: SlotId; by?: string; reason?: string } | null;
}

export interface PoolWash {
  booking_id: string;
  scheduled_date: string;
  time_slot: SlotId;
  booking_type: 'on_demand' | 'membership';
  service_name: string;
  vehicle_type: VehicleType;
  society_name: string | null;
  area_locality: string | null;
  city: string | null;
}

// ───────── admin ─────────
export interface AdminOverview {
  requests_to_quote: number;
  quotes_awaiting_customer: number;
  washes_today: number;
  washes_done_today: number;
  unassigned_next_3_days: number;
  issues_24h: number;
  unfulfilled_payments: number;
  refunds_requested: number;
  active_memberships: number;
}

export interface AdminRequest {
  id: string;
  reference_code: string;
  status: RequestStatus;
  customer: { profile_id: string; name: string | null; phone: string | null };
  vehicle: { id: string; type: VehicleType; model: string; registration_number: string };
  address: { society: string; block: string; flat: string; parking: string | null } | null;
  frequency_per_week: number;
  duration_months: number;
  weekly_pattern: PatternItem[];
  time_slot: SlotId;
  start_date: string;
  customer_notes: string | null;
  system_quote: (Omit<QuoteBreakdown, 'adjustment'> & { final_cents: number }) | null;
  adjustment_cents: number;
  adjustment_reason: string | null;
  quoted_amount_cents: number | null;
  quote_expires_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export interface AdminBooking {
  id: string;
  reference_code: string;
  status: BookingStatus;
  booking_type: 'on_demand' | 'membership';
  scheduled_date: string;
  time_slot: SlotId;
  membership_id: string | null;
  price_cents: number | null;
  customer_confirmed_at: string | null;
  parking_location: string | null;
  cancel_reason: string | null;
  service_name: string;
  wash_kind: WashKind | null;
  vehicle_type: VehicleType;
  vehicle_model: string;
  registration_number: string;
  vehicle_color: string | null;
  customer_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  society_name: string | null;
  building_block: string | null;
  flat_number: string | null;
  worker_id: string | null;
  worker_name: string | null;
}

export interface AdminEvent {
  event_type: string;
  created_at: string;
  meta: Record<string, any>;
  actor_name: string | null;
  actor_role: string | null;
}

export interface AdminMembership {
  id: string;
  status: string;
  duration_months: number;
  start_at: string;
  end_at: string;
  final_amount_cents: number;
  reference_code: string | null;
  frequency_per_week: number | null;
  weekly_pattern: PatternItem[] | null;
  time_slot: SlotId | null;
  customer_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  vehicle_type: VehicleType | null;
  vehicle_model: string | null;
  registration_number: string | null;
  worker_id: string | null;
  worker_name: string | null;
  washes_total: number;
  washes_completed: number;
  next_wash_date: string | null;
}

export interface Specialist {
  id: string;
  full_name: string | null;
  phone: string | null;
  washes_next_7_days: number;
}

export interface Attention {
  unfulfilled: { id: string; amount_cents: number; payment_kind: string; provider_payment_id: string | null; updated_at: string; customer_name: string | null; customer_phone: string | null }[];
  refunds: { id: string; amount_cents: number; reason: string; status: string; created_at: string; customer_name: string | null; customer_phone: string | null }[];
}
