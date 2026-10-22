import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withAnon } from '../db';
import { HttpError, fromPg } from '../errors';
import { withCouponGuard } from '../couponGuard';
import { cached } from '../publicCache';
import { monthlyNotInstalled } from '../plan';
import { workingDays, type WorkingDays } from '../routes/capacity';
import { publicSettings } from '../routes/settings';
import { cleanData, looksLikeAttack } from './guards';
import type { ToolDef } from './llm';
import type { Handles } from './store';
import { AgentError, type AddressCard, type Card, type MembershipCard, type MoneyLine, type SingleWashCard, type Slot, type VehicleCard, type VehicleKind } from './types';

/**
 * Everything Woshi can DO. Eight tools and no others: no query, no "run this", no way to name a customer. Each one:
 *   - takes no customer id and no database id. The model names a vehicle V1, an address A1, a service S1; the server turns that into the real id (a handle that does not exist, or one
 *     for somebody else, simply does not resolve), and the work is done through the signed-in customer's own database session, so row-level security hides everyone else's rows;
 *   - checks its input again with a strict schema, whatever the model sent;
 *   - hands back only what the model needs (no full registration numbers, no flat numbers), with anything a customer once typed cleaned (guards.cleanData);
 *   - never writes. The "propose" tools only make a CARD. Saving a vehicle and paying are done by the customer, on the card, through the same API calls the booking pages use.
 */
type Db = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;

export interface ToolCtx {
  db: Db;
  /** The signed-in customer's id (only used to count their wrong coupon codes, as the booking pages do). */
  sub: string;
  now: Date;
  today: string;
  /** What V1, A1 and S1 mean in this chat. */
  handles: Handles;
  /** Prices and percentages the tools have given in this chat: an answer may only state these. */
  amounts: Set<number>;
  percents: Set<number>;
  /** Cards made this turn. */
  cards: Card[];
  /** Quick replies chosen this turn. */
  quick: string[];
  /** Remember a card, so the server can tell a real one from a forgery. */
  keepCard: (c: Card) => void;
}

/** A refusal the model can read and act on ("that vehicle is not on this account"). Never a stack trace, never a database message that is not meant for people. */
class ToolFail extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// ───────────────────────── small helpers ─────────────────────────
export const SLOTS: { id: Slot; label: string; hours: string; startHour: number }[] = [
  { id: 'morning', label: 'Morning', hours: '7:00 – 11:00 AM', startHour: 7 },
  { id: 'afternoon', label: 'Afternoon', hours: '12:00 – 4:00 PM', startHour: 12 },
  { id: 'night', label: 'Night', hours: '7:00 – 10:00 PM', startHour: 19 },
];
const slotInfo = (id: Slot) => SLOTS.find((s) => s.id === id)!;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const istDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const dayLabel = (date: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T00:00:00Z`));
const startsAt = (date: string, slot: Slot) => new Date(`${date}T${String(slotInfo(slot).startHour).padStart(2, '0')}:00:00+05:30`).getTime();

/** What pricing needs of a chat: the customer's database session, who they are (for counting wrong coupon codes), and the figures the assistant may say. */
export type PriceCtx = Pick<ToolCtx, 'db' | 'sub' | 'amounts' | 'percents'>;

/** A price, remembered as one the assistant may say. */
const rupees = (ctx: PriceCtx, cents: number): number => {
  const v = Math.round(cents) / 100;
  ctx.amounts.add(v);
  return v;
};
const pct = (ctx: PriceCtx, bp: number): number => {
  const v = Math.round(bp) / 100;
  ctx.percents.add(v);
  return v;
};
const expiry = () => new Date(Date.now() + 20 * 60_000).toISOString();
const newId = () => crypto.randomUUID();

// ───────────────────────── what the database says ─────────────────────────
interface RawCatalog {
  services: { id: string; code: string; name: string; description: string | null; tagline: string | null; vehicle_type: VehicleKind; wash_kind: 'body' | 'deep' | null; duration_minutes: number | null; includes: string[] | null; unit_prices: { vehicle_type: VehicleKind; price_cents: number }[] | null }[];
  membership_options: { vehicle_type: VehicleKind; wash_kind: 'body' | 'deep'; service_code: string }[];
  discounts: { kind: 'frequency' | 'duration'; key: number; discount_bp: number; label: string }[];
  max_total_discount_bp: number;
  booking_rules: { on_demand_min_lead_hours: number; membership_min_lead_days: number };
}

/** The same rate card the website shows (and the same few seconds of memory). */
const loadCatalog = (): Promise<RawCatalog> =>
  cached('catalog', 30_000, async () => {
    const [catalog, rules] = await Promise.all([
      withAnon(async (c) => (await c.query('SELECT public.get_public_catalog() AS c')).rows[0].c),
      withAnon(async (c) => (await c.query(`SELECT key, value_int FROM public.pricing_settings WHERE key IN ('on_demand_min_lead_hours', 'membership_min_lead_days')`)).rows as { key: string; value_int: number }[]).catch(() => [] as { key: string; value_int: number }[]),
    ]);
    const rule = (key: string, fallback: number) => rules.find((r) => r.key === key)?.value_int ?? fallback;
    return { ...catalog, booking_rules: { on_demand_min_lead_hours: rule('on_demand_min_lead_hours', 2), membership_min_lead_days: rule('membership_min_lead_days', 2) } };
  }) as Promise<RawCatalog>;

/** The services a vehicle can have, with the rate-card price (a service for a car also serves an SUV; the SUV has its own price). The same rule as the booking page. */
function servicesFor(cat: RawCatalog, vt: VehicleKind) {
  return cat.services
    .filter((s) => s.vehicle_type === vt || (vt === 'suv' && s.vehicle_type === 'car'))
    .map((s) => ({ ...s, price_cents: s.unit_prices?.find((p) => p.vehicle_type === vt)?.price_cents ?? null }))
    .filter((s) => s.price_cents != null) as (RawCatalog['services'][number] & { price_cents: number })[];
}

export interface VehicleRow { id: string; vehicle_type: VehicleKind; make: string | null; model: string; registration_number: string; color: string | null; address_id: string | null; parking_location: string | null }
export interface AddressRow { id: string; label: string; society_name: string; building_block: string; flat_number: string; parking_location: string; area_locality: string; city: string; pincode: string; is_default: boolean }

const VEHICLE_SQL = `SELECT id, vehicle_type::text AS vehicle_type, make, model, registration_number, color, address_id, parking_location FROM public.vehicles WHERE is_active`;
const ADDRESS_SQL = `SELECT id, label, society_name, building_block, flat_number, parking_location, area_locality, city, pincode, is_default FROM public.customer_addresses a WHERE (to_jsonb(a) ->> 'archived_at') IS NULL`;

export const loadVehicles = (db: Db) => db(async (c) => (await c.query(`${VEHICLE_SQL} ORDER BY created_at LIMIT 20`)).rows as VehicleRow[]);
export const loadAddresses = (db: Db) => db(async (c) => (await c.query(`${ADDRESS_SQL} ORDER BY is_default DESC, created_at LIMIT 10`)).rows as AddressRow[]);

/** Reads the customer's vehicles and addresses and gives them handles V1.. and A1..: what V1 means is rebuilt from the database for every message. */
export async function refreshHandles(db: Db, handles: Handles): Promise<{ vs: VehicleRow[]; as: AddressRow[] }> {
  const [vs, as] = await Promise.all([loadVehicles(db), loadAddresses(db)]);
  handles.vehicles = new Map(vs.map((v, i) => [`V${i + 1}`, v.id]));
  handles.addresses = new Map(as.map((a, i) => [`A${i + 1}`, a.id]));
  return { vs, as };
}

/** What the model is told about a vehicle: no full registration number (only its last four characters), because the model never needs the rest. */
export const vehicleLine = (handle: string, v: Pick<VehicleRow, 'make' | 'model' | 'vehicle_type' | 'registration_number'>): string => {
  const tail = v.registration_number.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
  return `${handle} ${cleanData([v.make, v.model].filter(Boolean).join(' '), 40)} (${v.vehicle_type})${tail.length === 4 ? ` ends ${tail}` : ''}`;
};
/** And about an address: no block or flat number. */
export const addressLineForModel = (handle: string, a: Pick<AddressRow, 'label' | 'society_name' | 'parking_location' | 'is_default'>): string =>
  `${handle} ${cleanData(a.label, 20)}, ${cleanData(a.society_name, 40)}, parking ${cleanData(a.parking_location, 30)}${a.is_default ? ' (default)' : ''}`;

// ───────────────────────── handles ─────────────────────────
const resolve = (map: Map<string, string>, handle: string, what: 'vehicle' | 'address' | 'service'): string => {
  const id = map.get(handle.toUpperCase());
  if (!id) throw new ToolFail(`unknown_${what}`, `There is no ${what} "${handle}". Use a handle from <server_context>${what === 'service' ? ' or from get_catalog' : ''}.`);
  return id;
};
const serviceHandle = (ctx: ToolCtx, id: string): string => {
  let h = ctx.handles.serviceOf.get(id);
  if (!h) {
    h = `S${ctx.handles.services.size + 1}`;
    ctx.handles.services.set(h, id);
    ctx.handles.serviceOf.set(id, h);
  }
  return h;
};

/** A vehicle of THIS customer. Another customer's vehicle does not exist as far as this session can see (row-level security), so even a handle that somehow named one is just "not found". */
async function ownVehicle(ctx: ToolCtx, handle: string): Promise<VehicleRow> {
  const id = resolve(ctx.handles.vehicles, handle, 'vehicle');
  const row = (await ctx.db(async (c) => (await c.query(`${VEHICLE_SQL} AND id = $1`, [id])).rows[0])) as VehicleRow | undefined;
  if (!row) throw new ToolFail('unknown_vehicle', `That vehicle is not on this customer's account. Use a handle from <server_context>.`);
  return row;
}

/** The full details are for the customer's own screen (the cards), never for the model. */
const vehicleLabel = (v: { make?: string | null; model: string; registration_number: string }) => cleanData([v.make, v.model].filter(Boolean).join(' '), 60) + ` · ${cleanData(v.registration_number, 20)}`;
const modelLabel = (v: { make?: string | null; model: string }) => cleanData([v.make, v.model].filter(Boolean).join(' '), 60);
const addressLine = (a: Pick<AddressRow, 'society_name' | 'building_block' | 'flat_number'>) => `${cleanData(a.society_name, 60)}, ${cleanData(a.building_block, 20)} ${cleanData(a.flat_number, 20)}`;

async function pickAddress(ctx: ToolCtx, v: VehicleRow, handle: string | null | undefined): Promise<AddressRow> {
  const all = await loadAddresses(ctx.db);
  let a: AddressRow | undefined;
  if (handle) {
    const id = resolve(ctx.handles.addresses, handle, 'address');
    a = all.find((x) => x.id === id);
    if (!a) throw new ToolFail('unknown_address', `That address is not on this customer's account. Use a handle from <server_context>.`);
  } else {
    a = (v.address_id ? all.find((x) => x.id === v.address_id) : undefined) ?? all.find((x) => x.is_default) ?? all[0];
  }
  if (!a) throw new ToolFail('no_address', 'The customer has no saved address yet. Ask only for the society or building name, then call propose_address and wait for them to save it.');
  return a;
}

async function assertNotPaused() {
  const s = await publicSettings();
  if (s.maintenance_mode) throw new ToolFail('booking_paused', s.maintenance_message || 'Booking is paused for a little while. Ask the customer to check back soon.');
}

// ───────────────────────── when WASHO can come ─────────────────────────
type CrowdDay = { date: string; state?: string; slots?: Record<string, { state?: string }>; closed?: boolean };

async function crowdFor(ctx: ToolCtx, from: string, to: string): Promise<Map<string, CrowdDay>> {
  const days = (await ctx
    .db(async (c) => (await c.query('SELECT public.get_capacity($1::date, $2::date) AS r', [from, to])).rows[0].r.days as CrowdDay[])
    .catch((err) => {
      if ((err as { code?: string })?.code === '42883' || (err as { code?: string })?.code === '42P01') return [] as CrowdDay[]; // a database without capacity limits: nothing is full
      throw err;
    })) as CrowdDay[];
  return new Map(days.map((d) => [d.date, d]));
}

interface DayFacts { date: string; label: string; open: Slot[]; closed: { reason: string | null } | null }

/** For single washes: each date, and the windows a customer can still pick on it (not closed, not full, not too soon). The same rules the booking page applies; the database applies them again at payment. */
async function singleDays(ctx: ToolCtx, cat: RawCatalog, from: string, days: number): Promise<DayFacts[]> {
  const to = addDays(from, days - 1);
  const [wd, crowd] = await Promise.all([workingDays(ctx.db, from, to, 'single'), crowdFor(ctx, from, to)]);
  const closed = new Map((wd?.closed ?? []).map((c) => [c.date, c.reason]));
  const shut = new Set((wd?.closed_slots ?? []).map((c) => `${c.date}|${c.slot}`));
  const lead = cat.booking_rules.on_demand_min_lead_hours * 3_600_000;
  const out: DayFacts[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const c = crowd.get(date);
    const wholeDayClosed = closed.has(date);
    const open = wholeDayClosed || c?.state === 'full' ? [] : SLOTS.filter((s) => !shut.has(`${date}|${s.id}`) && c?.slots?.[s.id]?.state !== 'full' && startsAt(date, s.id) >= ctx.now.getTime() + lead).map((s) => s.id);
    out.push({ date, label: dayLabel(date), open, closed: wholeDayClosed ? { reason: closed.get(date) ?? null } : null });
  }
  return out;
}

/** The weekdays picked on which a window can never be used during the term: every such date is closed or has that window turned off. (Ported from the website's closedWindows.) */
function weekdaysWithoutWindow(slot: Slot, o: { weekdays: number[]; from: string; to: string; wd: WorkingDays | null }): number[] {
  if (!o.weekdays.length || o.to < o.from) return [];
  const shut = new Set([...(o.wd?.closed ?? []).map((c) => c.date), ...(o.wd?.closed_slots ?? []).filter((c) => c.slot === slot).map((c) => c.date)]);
  const hasOpen = new Set<number>();
  for (let d = o.from, i = 0; d <= o.to && i < 800; d = addDays(d, 1), i++) if (!shut.has(d)) hasOpen.add(weekdayOf(d));
  return o.weekdays.filter((w) => !hasOpen.has(w));
}

// ───────────────────────── the tools, as the model sees them (short on purpose) ─────────────────────────
const slotEnum = { type: 'string', enum: ['morning', 'afternoon', 'night'] } as const;
const handle = (what: string) => ({ type: 'string', description: what }) as const;
const coupon = { type: 'string', description: 'Only if the customer gave a coupon code.' } as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'get_catalog',
    description: 'Real services and prices (services as S1, S2...), membership discounts and rules. Give vehicle_type to see only that vehicle type.',
    input_schema: { type: 'object', properties: { vehicle_type: { type: 'string', enum: ['bike', 'car', 'suv'] } } },
  },
  {
    name: 'get_availability',
    description: 'When WASHO can come. kind single: the next days with open windows. kind membership: the earliest start date, the weekdays WASHO works, and windows unavailable on some weekdays.',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['single', 'membership'] }, from: { type: 'string', description: 'single only: first day, YYYY-MM-DD.' }, days: { type: 'integer', description: 'single only: how many days to look at, 1 to 21 (default 8).' } }, required: ['kind'] },
  },
  {
    name: 'quote_membership',
    description: 'Exact price of a membership plan with every discount: body and deep washes a month (4 to 28 in all; a bike has body only) for 1, 3, 6 or 12 months.',
    input_schema: { type: 'object', properties: { vehicle: handle('V1, V2...'), body: { type: 'integer' }, deep: { type: 'integer' }, months: { type: 'integer', description: '1, 3, 6 or 12.' }, coupon }, required: ['vehicle', 'body', 'deep', 'months'] },
  },
  {
    name: 'propose_vehicle',
    description: 'Show the customer a card to save a new vehicle. Nothing is saved until they tap Save. The customer types the registration number on the card, so leave it out unless they already said it. Always include the colour.',
    input_schema: { type: 'object', properties: { vehicle_type: { type: 'string', enum: ['bike', 'car', 'suv'] }, make: { type: 'string' }, model: { type: 'string' }, registration_number: { type: 'string' }, color: { type: 'string', description: 'For example White, Silver, Red.' } }, required: ['vehicle_type', 'model'] },
  },
  {
    name: 'propose_address',
    description: 'Show the customer a card to save a new address. Nothing is saved until they tap Save. Only the society is needed; the customer fills in block, flat and parking on the card.',
    input_schema: { type: 'object', properties: { society_name: { type: 'string' }, building_block: { type: 'string' }, flat_number: { type: 'string' }, parking_location: { type: 'string' }, label: { type: 'string', description: 'For example Home.' } }, required: ['society_name'] },
  },
  {
    name: 'propose_single_wash',
    description: "Check one wash against WASHO's rules and show the booking card with the exact price and the slide to pay. Nothing is booked or charged until the customer slides to pay. Use a day and window that get_availability said are open.",
    input_schema: { type: 'object', properties: { vehicle: handle('V1, V2...'), service: handle('S1, S2... from get_catalog'), date: { type: 'string', description: 'YYYY-MM-DD.' }, window: slotEnum, address: handle('A1, A2... (default: the vehicle\'s address)'), coupon }, required: ['vehicle', 'service', 'date', 'window'] },
  },
  {
    name: 'propose_membership',
    description: "Check a membership plan against WASHO's rules and show the plan card with the exact price and the slide to pay. Nothing is started or charged until the customer slides to pay. Weekdays: Sunday 0, Monday 1 ... Saturday 6.",
    input_schema: { type: 'object', properties: { vehicle: handle('V1, V2...'), body: { type: 'integer' }, deep: { type: 'integer' }, weekdays: { type: 'array', items: { type: 'integer' } }, months: { type: 'integer', description: '1, 3, 6 or 12.' }, window: slotEnum, start_date: { type: 'string', description: 'YYYY-MM-DD.' }, address: handle('A1, A2... (default: the vehicle\'s address)'), coupon }, required: ['vehicle', 'body', 'deep', 'weekdays', 'months', 'window', 'start_date'] },
  },
  {
    name: 'show_quick_replies',
    description: 'Show 2 to 4 short tappable choices under your message (suggestions only; the customer can type anything).',
    input_schema: { type: 'object', properties: { choices: { type: 'array', items: { type: 'string' } } }, required: ['choices'] },
  },
];

// ───────────────────────── what each tool accepts ─────────────────────────
const vh = z.string().trim().regex(/^V\d{1,2}$/i, 'Use a vehicle handle such as V1.');
const ah = z.string().trim().regex(/^A\d{1,2}$/i, 'Use an address handle such as A1.');
const sh = z.string().trim().regex(/^S\d{1,3}$/i, 'Use a service handle such as S1 (from get_catalog).');
const date = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const slot = z.enum(['morning', 'afternoon', 'night']);
const couponZ = z.string().trim().max(30).nullish().transform((v) => (v ? v : null));
const vtype = z.enum(['bike', 'car', 'suv']);
const months = z.number().int().refine((n) => [1, 3, 6, 12].includes(n), 'Months must be 1, 3, 6 or 12.');
const count = z.number().int().min(0).max(28);
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v ?? '');

const SCHEMAS = {
  get_catalog: z.strictObject({ vehicle_type: vtype.optional() }),
  get_availability: z.strictObject({ kind: z.enum(['single', 'membership']), from: date.optional(), days: z.number().int().min(1).max(21).optional() }),
  quote_membership: z.strictObject({ vehicle: vh, body: count, deep: count, months, coupon: couponZ }),
  propose_vehicle: z.strictObject({
    vehicle_type: vtype,
    make: optText(60),
    model: z.string().trim().min(1, 'Enter the model.').max(60),
    registration_number: z.string().trim().max(20).nullish().transform((v) => (v ? v.toUpperCase().replace(/\s+/g, ' ') : '')).refine((v) => v === '' || v.length >= 4, 'A registration number has at least 4 characters.'),
    color: optText(30),
  }),
  propose_address: z.strictObject({ society_name: z.string().trim().min(2).max(120), building_block: optText(40), flat_number: optText(40), parking_location: optText(160), label: z.string().trim().min(1).max(40).nullish().transform((v) => v ?? 'Home') }),
  propose_single_wash: z.strictObject({ vehicle: vh, service: sh, date, window: slot, address: ah.nullish().transform((v) => v ?? null), coupon: couponZ }),
  propose_membership: z.strictObject({ vehicle: vh, body: count, deep: count, weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), months, window: slot, start_date: date, address: ah.nullish().transform((v) => v ?? null), coupon: couponZ }),
  show_quick_replies: z.strictObject({ choices: z.array(z.string()).min(2).max(4) }),
} as const;

const MIN_PER_MONTH = 4;
const MAX_PER_MONTH = 28;
const daysNeeded = (washes: number) => Math.max(1, Math.ceil(washes / 4));

// ───────────────────────── doing them ─────────────────────────
type SingleEstimate = { list_cents: number; final_cents: number; coupon?: { code: string; bp: number; cents: number } };
type Breakdown = {
  lines: { name: string; quantity: number; unit_cents: number; line_cents: number }[];
  subtotal_cents: number;
  frequency_discount: { bp: number; cents: number; label: string | null };
  duration_discount: { bp: number; cents: number; label: string | null };
  cap?: { applied: boolean; adjustment_cents: number };
  coupon?: { code: string; bp: number; cents: number };
  total_discount_cents: number;
  final_cents: number;
};

const guarded = <T>(ctx: PriceCtx, code: string | null, run: () => Promise<T>) => (code ? withCouponGuard(ctx.sub, run) : run());

async function singleEstimate(ctx: PriceCtx, vehicleId: string, serviceId: string, code: string | null): Promise<SingleEstimate> {
  return guarded(ctx, code, () => ctx.db(async (c) => (await c.query('SELECT public.estimate_single_wash_with_coupon($1, $2, $3) AS q', [vehicleId, serviceId, code])).rows[0].q as SingleEstimate));
}

async function membershipEstimate(ctx: PriceCtx, vt: VehicleKind, body: number, deep: number, monthsN: number, code: string | null): Promise<Breakdown> {
  return guarded(ctx, code, () =>
    ctx.db(async (c) =>
      (code
        ? await c.query('SELECT public.estimate_monthly_price_with_coupon($1::public.vehicle_type, $2, $3, $4, $5) AS q', [vt, body, deep, monthsN, code])
        : await c.query('SELECT public.estimate_monthly_price($1::public.vehicle_type, $2, $3, $4) AS q', [vt, body, deep, monthsN])
      ).rows[0].q as Breakdown
    )
  ).catch((err) => {
    throw monthlyNotInstalled(err) ?? err;
  });
}

/** The money lines of a single-wash card, as the database priced it. */
const singleLines = (service: string, q: SingleEstimate): MoneyLine[] => [
  { label: service, cents: q.list_cents, tone: 'plain' },
  ...(q.coupon ? [{ label: `Coupon ${cleanData(q.coupon.code, 30)}`, cents: -q.coupon.cents, tone: 'discount' as const }] : []),
  { label: 'Total', cents: q.final_cents, tone: 'total' },
];

/** The money lines of a membership card, as the database priced it. */
function membershipLines(q: Breakdown): MoneyLine[] {
  const lines: MoneyLine[] = q.lines.map((l) => ({ label: `${cleanData(l.name, 50)} × ${l.quantity}`, cents: l.line_cents, tone: 'plain' as const }));
  if (q.frequency_discount.cents > 0) lines.push({ label: cleanData(q.frequency_discount.label, 50) || 'Frequency discount', cents: -q.frequency_discount.cents, tone: 'discount' });
  if (q.duration_discount.cents > 0) lines.push({ label: cleanData(q.duration_discount.label, 50) || 'Length discount', cents: -q.duration_discount.cents, tone: 'discount' });
  if (q.coupon) lines.push({ label: `Coupon ${cleanData(q.coupon.code, 30)}`, cents: -q.coupon.cents, tone: 'discount' });
  if (q.cap?.applied && q.cap.adjustment_cents) lines.push({ label: 'Discount limit adjustment', cents: q.cap.adjustment_cents, tone: 'plain' });
  lines.push({ label: 'Total', cents: q.final_cents, tone: 'total' });
  return lines;
}

/**
 * The customer typed a coupon on a pay card (or took it off: `code` null). The card is priced again by the database for this customer (it says in plain words why a code cannot be used,
 * and counts wrong codes as the booking pages do) and changed in place: its lines, its total and the coupon its payment will carry. A refused code leaves the card exactly as it was.
 * The payment itself prices everything once more, so a card can never pay less than the database allows.
 */
export async function repriceCard(ctx: PriceCtx, card: SingleWashCard | MembershipCard, code: string | null): Promise<void> {
  if (card.type === 'single_wash') {
    const q = await singleEstimate(ctx, card.pay.vehicle_id, card.pay.service_id, code);
    const lines = singleLines(card.lines[0].label, q);
    card.lines = lines;
    card.total_cents = q.final_cents;
    if (q.coupon) card.pay.coupon = q.coupon.code;
    else delete card.pay.coupon;
    for (const l of lines) rupees(ctx, Math.abs(l.cents));
    if (q.coupon) pct(ctx, q.coupon.bp);
    return;
  }
  const vt = (await ctx.db(async (c) => (await c.query('SELECT vehicle_type::text AS vt FROM public.vehicles WHERE is_active AND id = $1', [card.pay.vehicle_id])).rows[0]?.vt as VehicleKind | undefined));
  if (!vt) throw new AgentError(404, 'vehicle_gone', 'That vehicle is no longer on your account. Ask Woshi to start again.');
  const q = await membershipEstimate(ctx, vt, card.pay.monthly.body, card.pay.monthly.deep, card.pay.duration_months, code);
  const lines = membershipLines(q);
  card.lines = lines;
  card.total_cents = q.final_cents;
  card.per_month_cents = Math.round(q.final_cents / card.pay.duration_months);
  if (q.coupon) card.pay.coupon = q.coupon.code;
  else delete card.pay.coupon;
  for (const l of lines) rupees(ctx, Math.abs(l.cents));
  rupees(ctx, card.per_month_cents);
  if (q.coupon) pct(ctx, q.coupon.bp);
}

function checkWashRules(vt: VehicleKind, body: number, deep: number, weekdays: number[]) {
  const n = body + deep;
  if (n < MIN_PER_MONTH) throw new ToolFail('too_few_washes', `A membership needs at least ${MIN_PER_MONTH} washes a month in all.`);
  if (n > MAX_PER_MONTH) throw new ToolFail('too_many_washes', `A membership has at most ${MAX_PER_MONTH} washes a month.`);
  if (vt === 'bike' && deep > 0) throw new ToolFail('bike_body_only', 'A bike has Body washes only: set deep to 0.');
  const days = [...new Set(weekdays)];
  if (days.length < daysNeeded(n)) throw new ToolFail('too_few_weekdays', `${n} washes a month need at least ${daysNeeded(n)} different weekdays (a vehicle is washed once a day).`);
  return days;
}

const mix = (body: number, deep: number, bike: boolean) => [body > 0 && (bike ? `${body} Bike wash${body > 1 ? 'es' : ''}` : `${body} Body`), deep > 0 && `${deep} Deep`].filter(Boolean).join(' + ');

export interface ToolResult { content: string; isError: boolean }

const ok = (v: unknown): ToolResult => ({ content: JSON.stringify(v).slice(0, 6000), isError: false });
const fail = (code: string, message: string): ToolResult => ({ content: JSON.stringify({ error: code, message }), isError: true });

/** Puts a card in front of the customer (one of each kind per turn: a second replaces the first). */
function show(ctx: ToolCtx, card: Card) {
  ctx.cards = ctx.cards.filter((c) => c.type !== card.type);
  ctx.cards.push(card);
  ctx.keepCard(card);
}

export async function runTool(name: string, raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const schema = (SCHEMAS as Record<string, z.ZodType | undefined>)[name];
  if (!schema) return fail('unknown_tool', 'There is no such tool.');
  if (raw && typeof raw === 'object' && '__unreadable' in (raw as object)) return fail('bad_input', 'Your tool arguments were not valid JSON. Call the tool again with valid JSON.');
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return fail('bad_input', parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ').slice(0, 300));
  try {
    return await execute(name, parsed.data as never, ctx);
  } catch (err) {
    if (err instanceof ToolFail) return fail(err.code, err.message);
    // the database's own plain-English reasons (a coupon that cannot be used, a vehicle that already has a wash that day) are for the customer to hear
    if (err instanceof HttpError) return fail(err.code, err.message);
    const pg = fromPg(err);
    if (pg && pg.status < 500) return fail(pg.code, pg.message);
    console.error(`Woshi tool ${name} failed:`, err instanceof Error ? err.message : err);
    return fail('unavailable', 'That could not be checked right now. Tell the customer you could not check it, and suggest trying again in a moment or using the Book and Plans screens.');
  }
}

async function execute(name: string, a: Record<string, any>, ctx: ToolCtx): Promise<ToolResult> {
  switch (name) {
    case 'get_catalog': {
      const cat = await loadCatalog();
      const wanted = a.vehicle_type as VehicleKind | undefined;
      const types: VehicleKind[] = wanted ? [wanted] : ['bike', 'car', 'suv'];
      const seen = new Set<string>();
      const services = cat.services
        .filter((s) => (wanted ? servicesFor(cat, wanted).some((x) => x.id === s.id) : true))
        .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
        .map((s) => ({
          service: serviceHandle(ctx, s.id),
          name: cleanData(s.name, 60),
          kind: s.wash_kind,
          minutes: s.duration_minutes,
          about: cleanData(s.tagline ?? s.description, 100),
          includes: (s.includes ?? []).slice(0, 5).map((x) => cleanData(x, 60)),
          price_rupees: Object.fromEntries(types.map((t) => [t, (() => { const c = s.unit_prices?.find((p) => p.vehicle_type === t)?.price_cents; return c == null ? null : rupees(ctx, c); })()]).filter(([, v]) => v != null)),
        }))
        .filter((s) => Object.keys(s.price_rupees).length > 0);
      return ok({
        services,
        membership: {
          washes_a_month: `${MIN_PER_MONTH} to ${MAX_PER_MONTH}, body and deep in any mix; a bike has body only`,
          lengths_in_months: [1, 3, 6, 12],
          length_discount_percent: Object.fromEntries(cat.discounts.filter((d) => d.kind === 'duration').map((d) => [d.key, pct(ctx, d.discount_bp)])),
          frequency_discount_percent_by_washes_a_week: Object.fromEntries(cat.discounts.filter((d) => d.kind === 'frequency').map((d) => [d.key, pct(ctx, d.discount_bp)])),
          frequency_note: 'N washes a month earns the discount of floor(N / 4) washes a week (at most 7).',
          max_total_discount_percent: pct(ctx, cat.max_total_discount_bp),
        },
        notice: { single_wash_hours: cat.booking_rules.on_demand_min_lead_hours, membership_days: cat.booking_rules.membership_min_lead_days },
      });
    }

    case 'get_availability': {
      const cat = await loadCatalog();
      if (a.kind === 'single') {
        const from = a.from && a.from >= ctx.today ? a.from : ctx.today;
        const span = Math.min(a.days ?? 8, 21, 22 - Math.max(0, Math.round((Date.parse(from) - Date.parse(ctx.today)) / 86_400_000)));
        if (span < 1) throw new ToolFail('too_far_ahead', 'Single washes can be booked up to 21 days ahead.');
        const facts = await singleDays(ctx, cat, from, span);
        return ok({
          kind: 'single',
          notice: `A single wash needs at least ${cat.booking_rules.on_demand_min_lead_hours} hours' notice.`,
          days_with_open_windows: facts.filter((d) => d.open.length).slice(0, 7).map((d) => ({ date: d.date, label: d.label, open_windows: d.open })),
          closed: facts.filter((d) => d.closed).slice(0, 6).map((d) => ({ date: d.date, label: d.label, reason: cleanData(d.closed!.reason, 60) || null })),
          looked_at: { from, days: span },
        });
      }
      const earliest = addDays(ctx.today, cat.booking_rules.membership_min_lead_days);
      const to = addDays(earliest, 59);
      const wd = await workingDays(ctx.db, earliest, to, 'membership');
      const open = (wd?.weekdays ?? WEEKDAYS.map((_, i) => ({ weekday: i, open: true }))).filter((w) => w.open).map((w) => w.weekday);
      return ok({
        kind: 'membership',
        earliest_start_date: earliest,
        earliest_start_label: dayLabel(earliest),
        notice: `A membership needs at least ${cat.booking_rules.membership_min_lead_days} days' notice before it starts.`,
        open_weekdays: open.map((w) => ({ weekday: w, name: WEEKDAYS[w] })),
        windows_not_available: SLOTS.map((s) => ({ window: s.id, not_on: weekdaysWithoutWindow(s.id, { weekdays: open, from: earliest, to, wd }).map((w) => WEEKDAYS[w]) })).filter((w) => w.not_on.length),
        closed_dates: (wd?.closed ?? []).slice(0, 6).map((c) => ({ date: c.date, label: dayLabel(c.date), reason: cleanData(c.reason, 60) || null })),
      });
    }

    case 'quote_membership': {
      const v = await ownVehicle(ctx, a.vehicle);
      checkWashRules(v.vehicle_type, a.body, a.deep, Array.from({ length: daysNeeded(a.body + a.deep) }, (_, i) => i));
      const q = await membershipEstimate(ctx, v.vehicle_type, a.body, a.deep, a.months, a.coupon);
      return ok({
        vehicle: modelLabel(v),
        plan: `${a.body + a.deep} washes a month (${mix(a.body, a.deep, v.vehicle_type === 'bike')}) for ${a.months} month${a.months > 1 ? 's' : ''}`,
        subtotal_rupees: rupees(ctx, q.subtotal_cents),
        discounts: [
          q.frequency_discount.cents > 0 && { what: cleanData(q.frequency_discount.label, 60) || 'Frequency discount', percent: pct(ctx, q.frequency_discount.bp), off_rupees: rupees(ctx, q.frequency_discount.cents) },
          q.duration_discount.cents > 0 && { what: cleanData(q.duration_discount.label, 60) || 'Length discount', percent: pct(ctx, q.duration_discount.bp), off_rupees: rupees(ctx, q.duration_discount.cents) },
          q.coupon && { what: `Coupon ${cleanData(q.coupon.code, 30)}`, percent: pct(ctx, q.coupon.bp), off_rupees: rupees(ctx, q.coupon.cents) },
        ].filter(Boolean),
        total_rupees: rupees(ctx, q.final_cents),
        per_month_rupees: rupees(ctx, Math.round(q.final_cents / a.months)),
      });
    }

    case 'propose_vehicle': {
      for (const f of [a.make, a.model, a.registration_number, a.color]) if (f && looksLikeAttack(String(f))) throw new ToolFail('not_allowed', 'Those details cannot be saved. Ask the customer for the real make and model.');
      const have = await loadVehicles(ctx.db);
      if (a.registration_number && have.some((v) => v.registration_number.replace(/\s+/g, '').toUpperCase() === a.registration_number.replace(/\s+/g, ''))) throw new ToolFail('duplicate_vehicle', 'The customer has already saved this registration number. See saved_vehicles in <server_context>.');
      if (have.length >= 10) throw new ToolFail('too_many_vehicles', 'The customer already has the most vehicles an account can hold.');
      const addr = (await loadAddresses(ctx.db)).find((x) => x.is_default) ?? null;
      const card: VehicleCard = {
        id: newId(), type: 'vehicle', expires_at: expiry(),
        fields: { vehicle_type: a.vehicle_type, make: a.make, model: a.model, registration_number: a.registration_number, color: a.color, address_id: addr?.id ?? null, parking_location: addr?.parking_location ?? '' },
      };
      show(ctx, card);
      return ok({ result: 'card_shown', card: 'vehicle', note: 'The customer checks the details, types the registration number if it is empty, and taps Save. Nothing is saved yet: do not say it is. The server tells you when it is.' });
    }

    case 'propose_address': {
      for (const f of [a.society_name, a.building_block, a.flat_number, a.parking_location, a.label]) if (f && looksLikeAttack(String(f))) throw new ToolFail('not_allowed', 'Those details cannot be saved. Ask the customer for the real society name.');
      const card: AddressCard = {
        id: newId(), type: 'address', expires_at: expiry(),
        fields: { label: a.label, society_name: a.society_name, building_block: a.building_block, flat_number: a.flat_number, parking_location: a.parking_location, area_locality: 'Kharadi', city: 'Pune', pincode: '411014' },
      };
      show(ctx, card);
      return ok({ result: 'card_shown', card: 'address', note: 'The customer fills in block, flat and parking on the card and taps Save. Nothing is saved yet: do not say it is. The server tells you when it is.' });
    }

    case 'propose_single_wash': {
      await assertNotPaused();
      const cat = await loadCatalog();
      const v = await ownVehicle(ctx, a.vehicle);
      const serviceId = resolve(ctx.handles.services, a.service, 'service');
      const svc = servicesFor(cat, v.vehicle_type).find((s) => s.id === serviceId);
      if (!svc) throw new ToolFail('service_not_for_vehicle', 'That service is not offered for this vehicle. Use a service from get_catalog for its type.');
      if (a.date < ctx.today || a.date > addDays(ctx.today, 21)) throw new ToolFail('date_out_of_range', 'Single washes can be booked from today up to 21 days ahead.');
      const [day] = await singleDays(ctx, cat, a.date, 1);
      if (day.closed) throw new ToolFail('closed_day', `WASHO is unavailable on ${day.label}${day.closed.reason ? ` (${cleanData(day.closed.reason, 60)})` : ''}. Call get_availability and offer another day.`);
      if (!day.open.includes(a.window)) throw new ToolFail('window_not_open', `The ${slotInfo(a.window).label} window is not open on ${day.label}${day.open.length ? `; open that day: ${day.open.map((s) => slotInfo(s).label).join(', ')}` : ' (nothing is open that day)'}. Call get_availability and offer another.`);
      const addr = await pickAddress(ctx, v, a.address);
      const q = await singleEstimate(ctx, v.id, svc.id, a.coupon);
      const lines = singleLines(cleanData(svc.name, 60), q);
      const card: SingleWashCard = {
        id: newId(), type: 'single_wash', expires_at: expiry(),
        title: cleanData(svc.name, 60),
        description: cleanData(svc.tagline ?? svc.description, 140),
        rows: [
          { label: 'Vehicle', value: vehicleLabel(v) },
          { label: 'When', value: `${dayLabel(a.date)} · ${slotInfo(a.window).label} (${slotInfo(a.window).hours})` },
          { label: 'Where', value: addressLine(addr) },
          { label: 'Parking', value: cleanData(addr.parking_location, 60) },
        ],
        lines,
        total_cents: q.final_cents,
        pay: { vehicle_id: v.id, service_id: svc.id, scheduled_date: a.date, time_slot: a.window, address_id: addr.id, ...(addr.parking_location ? { parking_location: addr.parking_location } : {}), ...(q.coupon ? { coupon: q.coupon.code } : {}) },
      };
      rupees(ctx, q.list_cents);
      show(ctx, card);
      return ok({ result: 'card_shown', card: 'single_wash', service: card.title, when: card.rows[1].value, total_rupees: rupees(ctx, q.final_cents), note: "The booking card is on the customer's screen. They must slide to pay on it. You cannot take payment and nothing is booked yet: do not say it is." });
    }

    case 'propose_membership': {
      await assertNotPaused();
      const cat = await loadCatalog();
      const v = await ownVehicle(ctx, a.vehicle);
      const days = checkWashRules(v.vehicle_type, a.body, a.deep, a.weekdays);
      const earliest = addDays(ctx.today, cat.booking_rules.membership_min_lead_days);
      if (a.start_date < earliest) throw new ToolFail('start_too_soon', `A membership needs ${cat.booking_rules.membership_min_lead_days} days' notice: the earliest start is ${dayLabel(earliest)} (${earliest}).`);
      if (a.start_date > addDays(ctx.today, 120)) throw new ToolFail('start_too_far', 'Choose a start date within the next 4 months.');
      // which weekdays does WASHO work, and does the window work on them for the whole term
      const preview = (await ctx
        .db(async (c) => (await c.query('SELECT public.preview_monthly_dates($1, $2, $3, $4::integer[], $5, $6::public.time_slot, $7::date) AS r', [v.id, a.body, a.deep, days, a.months, a.window, a.start_date])).rows[0].r as { fits: boolean; end_date: string })
        .catch((err) => { throw monthlyNotInstalled(err) ?? err; }));
      if (preview.fits === false) throw new ToolFail('plan_does_not_fit', 'This plan does not fit on those weekdays in that window (some days are full or closed). Offer more weekdays, another window or another start date.');
      const wd = await workingDays(ctx.db, a.start_date, preview.end_date, 'membership');
      const closedWeekdays = (wd?.weekdays ?? []).filter((w) => !w.open).map((w) => w.weekday);
      const shutDays = days.filter((d) => closedWeekdays.includes(d));
      if (shutDays.length) throw new ToolFail('weekday_closed', `WASHO does not work on ${shutDays.map((d) => WEEKDAYS[d]).join(', ')}. Call get_availability with kind "membership" and offer other weekdays.`);
      const noWindow = weekdaysWithoutWindow(a.window, { weekdays: days, from: a.start_date, to: preview.end_date, wd });
      if (noWindow.length) throw new ToolFail('window_off_on_weekday', `The ${slotInfo(a.window).label} window is not available on ${noWindow.map((d) => WEEKDAYS[d]).join(', ')}. Offer another window or other weekdays.`);
      const addr = await pickAddress(ctx, v, a.address);
      const q = await membershipEstimate(ctx, v.vehicle_type, a.body, a.deep, a.months, a.coupon);
      const lines = membershipLines(q);
      const perMonth = Math.round(q.final_cents / a.months);
      const card: MembershipCard = {
        id: newId(), type: 'membership', expires_at: expiry(),
        title: `${a.body + a.deep} washes a month · ${a.months} month${a.months > 1 ? 's' : ''}`,
        description: mix(a.body, a.deep, v.vehicle_type === 'bike') + ' a month',
        rows: [
          { label: 'Vehicle', value: vehicleLabel(v) },
          { label: 'Days', value: [...days].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7)).map((d) => WEEKDAYS[d].slice(0, 3)).join(' · ') },
          { label: 'Starts', value: `${dayLabel(a.start_date)} · ${slotInfo(a.window).label} (${slotInfo(a.window).hours})` },
          { label: 'Where', value: addressLine(addr) },
        ],
        lines,
        total_cents: q.final_cents,
        per_month_cents: perMonth,
        pay: { vehicle_id: v.id, monthly: { body: a.body, deep: a.deep, weekdays: days }, duration_months: a.months, time_slot: a.window, start_date: a.start_date, address_id: addr.id, ...(addr.parking_location ? { parking_location: addr.parking_location } : {}), ...(q.coupon ? { coupon: q.coupon.code } : {}) },
      };
      for (const l of lines) rupees(ctx, Math.abs(l.cents));
      show(ctx, card);
      return ok({ result: 'card_shown', card: 'membership', plan: card.title, total_rupees: rupees(ctx, q.final_cents), per_month_rupees: rupees(ctx, perMonth), note: "The plan card is on the customer's screen. They must slide to pay on it. You cannot take payment and nothing is started yet: do not say it is." });
    }

    case 'show_quick_replies': {
      const choices = (a.choices as string[])
        .map((c) => cleanData(c, 32))
        .filter((c) => c && c !== '[hidden]' && !/https?:|www\./i.test(c))
        .slice(0, 4);
      if (choices.length < 2) throw new ToolFail('bad_choices', 'Give 2 to 4 short plain choices.');
      ctx.quick = choices;
      return ok({ shown: choices.length });
    }
  }
  return fail('unknown_tool', 'There is no such tool.');
}

/** Money formatting for the server's own messages (the receipt after a verified payment). */
export const prettyDay = dayLabel;
export const slotText = (s: Slot) => `${slotInfo(s).label} (${slotInfo(s).hours})`;
export const istToday = istDay;
