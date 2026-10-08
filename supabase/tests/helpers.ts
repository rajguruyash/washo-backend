import { Client } from 'pg';
import crypto from 'crypto';

export const DB = process.env.SB_TEST_DB;
if (!DB) throw new Error('SB_TEST_DB is not set. Run tests through supabase/tests/run.sh');
if (!/^washo_[a-z_]+$/.test(DB)) throw new Error(`Refusing to run against "${DB}"`);

export type Role = 'anon' | 'authenticated' | 'service_role' | 'washo_api' | 'postgres';

export interface Session {
  c: Client;
  /** Run SQL as a Postgres/Supabase role, optionally signed in as an auth user. */
  as: (role: Role, authUserId?: string | null) => Promise<void>;
  q: <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** The SQL error message a statement raises (as the current role), or null if it succeeds. */
  err: (sql: string, params?: unknown[]) => Promise<string | null>;
}

/**
 * Every test runs in one transaction that is rolled back, so tests are isolated and fast.
 * Starts as the (super)user so fixtures can be inserted freely; switch role with s.as().
 */
export async function inTx<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  const c = new Client({ database: DB });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL TIME ZONE 'UTC'"); // Supabase runs in UTC
    const q = async (sql: string, params?: unknown[]) => (await c.query(sql, params as any[])).rows;
    const s: Session = {
      c,
      q,
      as: async (role, authUserId) => {
        await c.query('RESET ROLE');
        await c.query('SELECT set_config($1, $2, true)', [
          'request.jwt.claims',
          authUserId ? JSON.stringify({ sub: authUserId, role: role === 'anon' ? 'anon' : 'authenticated' }) : '',
        ]);
        if (role !== 'postgres') await c.query(`SET LOCAL ROLE ${role}`);
      },
      err: async (sql, params) => {
        await c.query('SAVEPOINT t');
        try {
          await c.query(sql, params as any[]);
          await c.query('RELEASE SAVEPOINT t');
          return null;
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT t');
          return (e as Error).message;
        }
      },
    };
    return await fn(s);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

let n = 0;
export const uid = () => crypto.randomUUID();
export const nextPhone = () => `+9198${String(70000000 + ++n + Math.floor(Math.random() * 1e5)).slice(-8)}`;

export interface TestUser {
  authId: string;
  profileId: string;
  phone: string | null;
  email: string | null;
}

/** Inserts an auth user the way GoTrue does; the real trigger then creates/links the profile. */
export async function createAuthUser(
  s: Session,
  o: { email?: string; phone?: string; phoneConfirmed?: boolean; metadataPhone?: string; fullName?: string } = {}
): Promise<TestUser> {
  await s.as('postgres');
  const id = uid();
  const email = o.email ?? null;
  await s.q(
    `INSERT INTO auth.users (id, instance_id, aud, role, email, phone, phone_confirmed_at, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, $3,
             CASE WHEN $4::boolean THEN now() END, $5::jsonb, now(), now())`,
    [id, email, o.phone ?? null, o.phoneConfirmed ?? false, JSON.stringify({ full_name: o.fullName ?? 'Test User', ...(o.metadataPhone ? { phone: o.metadataPhone } : {}) })]
  );
  const p = await s.q('SELECT id, phone FROM public.profiles WHERE auth_user_id = $1', [id]);
  return { authId: id, profileId: p[0]?.id, phone: p[0]?.phone ?? null, email };
}

export async function setRole(s: Session, profileId: string, role: 'customer' | 'worker' | 'admin') {
  await s.as('postgres');
  await s.q("SELECT set_config('washo.allow_role_change','on',true)");
  await s.q('UPDATE public.profiles SET role = $2 WHERE id = $1', [profileId, role]);
}

export async function createCustomer(s: Session, o: { phone?: string; email?: string } = {}) {
  return createAuthUser(s, { email: o.email ?? `${uid()}@t.test`, phone: o.phone ?? nextPhone(), phoneConfirmed: true });
}

export async function createWorker(s: Session) {
  const u = await createCustomer(s);
  await setRole(s, u.profileId, 'worker');
  return u;
}

export type AdminAccess = 'super_admin' | 'operations' | 'finance' | 'marketing' | 'support';

/** An admin. Since migration 27 an admin also has a role (admin_access); the default is the owner's, which can do everything. */
export async function createAdmin(s: Session, access: AdminAccess | null = 'super_admin') {
  const u = await createCustomer(s);
  await setRole(s, u.profileId, 'admin');
  if (access) await s.q(`DO $$ BEGIN IF to_regclass('public.admin_access') IS NOT NULL THEN INSERT INTO public.admin_access (profile_id, access) VALUES ('${u.profileId}', '${access}') ON CONFLICT (profile_id) DO UPDATE SET access = EXCLUDED.access; END IF; END $$`);
  return u;
}

let plate = 1000;
export async function createVehicle(s: Session, profileId: string, type: 'bike' | 'car' | 'suv' = 'car') {
  await s.as('postgres');
  const r = await s.q(
    `INSERT INTO public.vehicles (customer_profile_id, vehicle_type, make, model, registration_number)
     VALUES ($1, $2, 'Test', 'Model', $3) RETURNING id`,
    [profileId, type, `MH12AB${++plate}`]
  );
  return r[0].id as string;
}

export async function createAddress(s: Session, profileId: string) {
  await s.as('postgres');
  const r = await s.q(
    `INSERT INTO public.customer_addresses (customer_profile_id, society_name, building_block, flat_number, parking_location, is_default)
     VALUES ($1, 'Yashwin Orizzonte', 'B', 'B-702', 'Basement P1', true) RETURNING id`,
    [profileId]
  );
  return r[0].id as string;
}

/** Looks up a seeded service id by code (present after the pricing migration). */
export async function serviceId(s: Session, code: string): Promise<string> {
  await s.as('postgres');
  return (await s.q('SELECT id FROM public.services WHERE code = $1', [code]))[0].id;
}

/** A date `days` from today in Asia/Kolkata, as YYYY-MM-DD. */
export async function istDate(s: Session, days: number): Promise<string> {
  await s.as('postgres');
  return (await s.q(`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`, [days]))[0].d;
}

export const PATTERN_3 = [{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'deep' }, { weekday: 5, kind: 'body' }];

/**
 * A real, PAID, active membership, created through the production path:
 * request -> WASHO quote -> accept -> Razorpay order -> verified payment -> washes generated.
 */
export async function paidMembership(s: Session, o: { pattern?: unknown[]; months?: number; vtype?: 'bike' | 'car' | 'suv'; startDays?: number; notes?: string } = {}) {
  const admin = await createAdmin(s);
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, o.vtype ?? 'car');
  const start = await istDate(s, o.startDays ?? 4);
  await s.as('authenticated', u.authId);
  const id = (await s.q(
    `select public.create_membership_request($1,$2::jsonb,$3,'morning',$4::date,$5,'Basement P1',$6) id`,
    [veh, JSON.stringify(o.pattern ?? PATTERN_3), o.months ?? 1, start, addr, o.notes ?? 'Gate code 4321']
  ))[0].id;
  await s.as('authenticated', admin.authId);
  await s.q(`select public.admin_review_membership_request($1,'quote')`, [id]);
  await s.as('authenticated', u.authId);
  const acc = (await s.q('select public.accept_membership_quote($1) r', [id]))[0].r;
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [acc.payment_id, order]);
  const r = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 6)}`, acc.amount_cents]))[0].r;
  await s.as('postgres');
  const washes = await s.q(
    `select b.id booking_id, o.id occ, to_char(b.scheduled_date,'YYYY-MM-DD') d, b.time_slot::text slot
       from public.bookings b join public.membership_schedule_occurrences o on o.id = b.membership_schedule_occurrence_id
      where b.membership_id = $1 order by b.scheduled_date`,
    [r.membership_id]
  );
  return { admin, u, addr, veh, washes, membership: r.membership_id as string, requestId: id as string };
}

/** A confirmed on-demand booking dated `days` from today (0 = today), for queue-bucket tests. */
export async function confirmedBooking(s: Session, o: { days?: number; status?: string } = {}) {
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, 'car');
  const svc = await serviceId(s, 'car-body-wash');
  await s.as('postgres');
  const id = (await s.q(
    `insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status,address_id,parking_location)
     values ($1,$2,$3,'on_demand',(now() at time zone 'Asia/Kolkata')::date + $4::int,'morning',$5,$6,'Basement P2') returning id`,
    [u.profileId, veh, svc, o.days ?? 0, o.status ?? 'confirmed', addr]
  ))[0].id as string;
  return { u, id, veh, addr };
}
