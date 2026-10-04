/** The specialist's workflow over HTTP, and WASHO's admin handling of washes, against the real database rules. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, JPEG, PNG, activeMembership, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

let admin: Client;
beforeAll(async () => {
  admin = (await staffClient('admin')).c;
});

const upload = (c: Client, id: string, phase: string, type: string, bytes = JPEG, contentType = 'image/jpeg') =>
  c.req('POST', `/api/bookings/${id}/photos?phase=${phase}&type=${type}`, undefined, { raw: bytes, contentType });
const step = (c: Client, id: string, s: string, body: unknown = {}) => c.post(`/api/worker/washes/${id}/${s}`, body);

async function membershipWithWorker() {
  const w = await staffClient('worker', { name: 'Ravi Patil', phone: '9876500001' });
  const m = await activeMembership({ admin, notes: 'Gate code 4321, dog on site' });
  expectOk(await admin.post(`/api/admin/memberships/${m.membershipId}/assign-worker`, { worker_profile_id: w.profileId }));
  const washes = expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes;
  return { w, m, washes };
}

describe('worker queue', () => {
  it('shows an assigned membership wash with everything the specialist needs', async () => {
    const { w, m, washes } = await membershipWithWorker();
    const queue = expectOk(await w.c.get('/api/worker/queue?days=60')).body.queue;
    expect(queue).toHaveLength(12);
    const first = queue.find((q: any) => q.booking_id === washes[0].id);
    expect(first).toMatchObject({
      status: 'worker_assigned', bucket: 'upcoming', booking_type: 'membership', time_slot: 'morning',
      customer_name: 'Asha Kulkarni', vehicle_type: 'car', vehicle_make: 'Hyundai', vehicle_model: 'Creta', vehicle_color: 'White', registration_number: m.reg,
      society_name: 'Yashwin Orizzonte', building_block: 'B', flat_number: 'B-702', parking_location: 'Basement P1',
      instructions: 'Gate code 4321, dog on site', membership_id: m.membershipId, membership_label: '3 washes a week · 1 month', wash_number: 1, washes_total: 12,
    });
    expect(first.customer_phone).toBe(`+91${m.phone}`);
    expect(first.membership_reference).toMatch(/^MR-/);
    expect(['Car Body Wash', 'Car Deep Cleaning']).toContain(first.service_name);
  });

  it('a worker sees only their own washes: another specialist, and the pool, expose no customer data', async () => {
    const { w, m } = await membershipWithWorker();
    const other = await staffClient('worker');
    expect(expectOk(await other.c.get('/api/worker/queue?days=60')).body.queue).toHaveLength(0);

    const pool = expectOk(await other.c.get('/api/worker/pool')).body.pool;
    for (const row of pool) {
      expect(Object.keys(row).sort()).toEqual(['area_locality', 'booking_id', 'booking_type', 'city', 'scheduled_date', 'service_name', 'society_name', 'time_slot', 'vehicle_type']);
    }
    // direct customer-detail routes are closed to workers
    for (const p of ['/api/vehicles', '/api/addresses', '/api/memberships', '/api/membership-requests', `/api/memberships/${m.membershipId}`]) {
      expect((await other.c.get(p)).status, p).toBe(403);
    }
    // another worker cannot act on w's wash
    const wash = expectOk(await w.c.get('/api/worker/queue?days=60')).body.queue[0];
    for (const s of ['call', 'confirm', 'start', 'complete', 'not-picked-up']) {
      const r = await step(other.c, wash.booking_id, s);
      expect(r.status, s).toBeGreaterThanOrEqual(400);
    }
    expect((await upload(other.c, wash.booking_id, 'before', 'front')).status).toBeGreaterThanOrEqual(400);
    expect(Array.from(fake.objects.keys()).filter((k) => k.includes(wash.booking_id))).toHaveLength(0); // nothing was stored
    expect((await other.c.get(`/api/bookings/${wash.booking_id}/photos`)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('the wash, step by step', () => {
  it('call -> customer confirmed -> start -> before photos -> after photos -> complete; then the next wash is already queued', async () => {
    const { w, m, washes } = await membershipWithWorker();
    // make this wash "today" for the queue by claiming the earliest one; it is upcoming but actionable
    const id = washes[0].id;

    expect((await step(w.c, id, 'start')).body.wash.status).toBe('in_progress'); // start works straight from assigned (call is optional in the DB)
    // but the normal path first:
    const { w: w2, washes: washes2 } = await membershipWithWorker();
    const id2 = washes2[0].id;
    const called = expectOk(await step(w2.c, id2, 'call')).body.wash;
    expect(called).toMatchObject({ status: 'worker_called', calls_made: 1, customer_confirmed_at: null });
    const confirmed = expectOk(await step(w2.c, id2, 'confirm')).body.wash;
    expect(confirmed.customer_confirmed_at).toBeTruthy();
    expect(expectOk(await step(w2.c, id2, 'start')).body.wash).toMatchObject({ status: 'in_progress', bucket: 'in_progress' });

    // completion is refused without photos
    expect((await step(w2.c, id2, 'complete')).body.message).toMatch(/before photo is required/);
    const b1 = expectOk(await upload(w2.c, id2, 'before', 'front'));
    expect(b1.status).toBe(201);
    expect((await step(w2.c, id2, 'complete')).body.message).toMatch(/after photo is required/);
    expectOk(await upload(w2.c, id2, 'before', 'rear', PNG, 'image/png'));
    expectOk(await upload(w2.c, id2, 'after', 'front'));
    const queueRow = expectOk(await w2.c.get('/api/worker/queue?days=60')).body.queue.find((q: any) => q.booking_id === id2);
    expect(queueRow).toMatchObject({ photos_before: 2, photos_after: 1 });

    const done = expectOk(await step(w2.c, id2, 'complete')).body.wash;
    expect(done).toMatchObject({ status: 'completed', bucket: 'completed', customer_phone: null });
    expect(done.completed_at).toBeTruthy();

    // the next scheduled wash is already in the queue: nothing had to be created or assigned again
    const queue = expectOk(await w2.c.get('/api/worker/queue?days=60')).body.queue;
    expect(queue.find((q: any) => q.booking_id === washes2[1].id)).toMatchObject({ status: 'worker_assigned', bucket: 'upcoming', wash_number: 2 });
    expect(queue.filter((q: any) => q.bucket === 'upcoming')).toHaveLength(11);

    // the customer sees the progress and the photos (signed, short-lived links)
    const customerView = expectOk(await m.c.get(`/api/bookings/${id}`)).body; // the first membership's wash (started above)
    expect(customerView.booking.status).toBe('in_progress');
    const mine2 = expectOk(await w2.c.get(`/api/bookings/${id2}/photos`)).body.photos;
    expect(mine2).toHaveLength(3);
    expect(mine2[0].url).toMatch(/\/storage\/v1\/object\/sign\/wash-photos\/.+\?token=/);
    const bytes = await fetch(mine2[0].url);
    expect(bytes.status).toBe(200);
  });

  it('the customer sees photos on their own completed wash; a stranger cannot', async () => {
    const { w, m, washes } = await membershipWithWorker();
    const id = washes[0].id;
    expectOk(await step(w.c, id, 'start'));
    expectOk(await upload(w.c, id, 'before', 'front'));
    expectOk(await upload(w.c, id, 'after', 'front'));
    expectOk(await step(w.c, id, 'complete'));
    const photos = expectOk(await m.c.get(`/api/bookings/${id}/photos`)).body.photos;
    expect(photos.map((p: any) => p.phase).sort()).toEqual(['after', 'before']);
    const stranger = await customerWithVehicle();
    expect((await stranger.c.get(`/api/bookings/${id}/photos`)).status).toBeGreaterThanOrEqual(400);
    const detail = expectOk(await m.c.get(`/api/bookings/${id}`)).body;
    expect(detail.booking.status).toBe('completed');
    expect(detail.events.map((e: any) => e.event_type)).toContain('wash_completed');
    // worker notes and issue text are not part of the customer's timeline
    expect(JSON.stringify(detail.events)).not.toMatch(/worker_note|worker_issue/);
  });

  it('not picked up: the wash stays scheduled, is not completed, and the specialist can call again', async () => {
    const { w, washes } = await membershipWithWorker();
    const id = washes[0].id;
    expectOk(await step(w.c, id, 'call'));
    const r = expectOk(await step(w.c, id, 'not-picked-up', { notes: 'Rang 3 times' })).body.wash;
    expect(r).toMatchObject({ status: 'call_not_picked_up', bucket: 'upcoming', completed_at: null, customer_confirmed_at: null });
    expect((await step(w.c, id, 'complete')).status).toBeGreaterThanOrEqual(400);
    const again = expectOk(await step(w.c, id, 'call')).body.wash;
    expect(again).toMatchObject({ status: 'worker_called', calls_made: 2 });
    expect(expectOk(await step(w.c, id, 'confirm')).body.wash.customer_confirmed_at).toBeTruthy();
    const { rows } = await fake.admin.query(`SELECT count(*)::int n FROM public.payments pay JOIN public.memberships m ON m.id = pay.membership_id WHERE m.id = (SELECT membership_id FROM public.bookings WHERE id = $1)`, [id]);
    expect(rows[0].n).toBe(1); // nothing was charged or refunded
  });

  it('issues and notes are recorded for WASHO; "customer unavailable" before the start is the same as not picked up', async () => {
    const { w, washes } = await membershipWithWorker();
    const id = washes[0].id;
    expect((await step(w.c, id, 'issue', { kind: 'other' })).body.message).toMatch(/describe the problem/);
    expect((await step(w.c, id, 'issue', { kind: 'bogus', notes: 'xx yy' })).status).toBe(400);
    expect((await step(w.c, id, 'note', { note: '' })).status).toBe(400);
    expectOk(await step(w.c, id, 'start'));
    expectOk(await step(w.c, id, 'issue', { kind: 'no_water_or_power', notes: 'Society water is off until 11' }));
    expectOk(await step(w.c, id, 'note', { note: 'Scratch on rear bumper, already there' }));
    const detail = expectOk(await admin.get(`/api/admin/bookings/${id}`)).body;
    const types = detail.events.map((e: any) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['membership_worker_assigned', 'wash_started', 'worker_issue', 'worker_note']));
    expect(detail.events.find((e: any) => e.event_type === 'worker_issue')).toMatchObject({ meta: { kind: 'no_water_or_power' }, actor_name: 'Ravi Patil', actor_role: 'worker' });

    const second = washes[1].id;
    expect(expectOk(await step(w.c, second, 'issue', { kind: 'customer_unavailable', notes: 'Not home' })).body.wash.status).toBe('call_not_picked_up');
  });

  it('photo uploads are checked: type, size, content, phase and the wash must be open', async () => {
    const { w, washes } = await membershipWithWorker();
    const id = washes[0].id;
    // the database accepts photos while a wash is open (the app makes the worker start first); finished washes are closed
    expectOk(await step(w.c, id, 'start'));
    expect((await upload(w.c, id, 'before', 'front', Buffer.from('<?php echo 1; ?>' + 'x'.repeat(40)), 'image/jpeg')).status).toBe(415); // not an image
    expect((await upload(w.c, id, 'sideways', 'front')).status).toBe(400);
    expect((await upload(w.c, id, 'before', 'top')).status).toBe(400);
    expect((await w.c.req('POST', `/api/bookings/${id}/photos?phase=before&type=front`, undefined, { raw: Buffer.from('hello'), contentType: 'text/plain' })).status).toBe(400);
    expect((await w.c.req('POST', `/api/bookings/${id}/photos?phase=before&type=front`, undefined, { raw: Buffer.concat([JPEG, Buffer.alloc(9 * 1024 * 1024)]), contentType: 'image/jpeg' })).status).toBe(413);
    expectOk(await upload(w.c, id, 'before', 'front'));
    expectOk(await step(w.c, id, 'note', { note: 'ok fine' }));
    expectOk(await upload(w.c, id, 'after', 'front'));
    expectOk(await step(w.c, id, 'complete'));
    expect((await upload(w.c, id, 'after', 'additional')).status).toBe(422); // finished wash: closed
  });
});

describe('moves and cancellations update the queue automatically', () => {
  it('a customer reschedule returns the wash to the regular specialist on its new date, flagged as moved', async () => {
    const { w, m, washes } = await membershipWithWorker();
    const wash = washes[0];
    expectOk(await step(w.c, wash.id, 'call'));
    expectOk(await step(w.c, wash.id, 'confirm'));
    const target = (() => {
      let d = 24;
      while (new Date(`${istDate(d)}T00:00:00Z`).getUTCDay() !== 2) d++;
      return istDate(d);
    })();
    expectOk(await m.c.post(`/api/bookings/${wash.id}/reschedule`, { date: target, time_slot: 'night' }));
    const row = expectOk(await w.c.get('/api/worker/queue?days=60')).body.queue.find((q: any) => q.booking_id === wash.id);
    expect(row).toMatchObject({ scheduled_date: target, time_slot: 'night', status: 'worker_assigned', customer_confirmed_at: null, customer_name: 'Asha Kulkarni' });
    expect(row.change).toMatchObject({ kind: 'rescheduled', by: 'customer', from_slot: 'morning' });
    expect(row.change.from_date).toBe(washes[0].scheduled_date);
  });

  it('admin cancelling a wash drops it into the specialist\'s "cancelled / rescheduled" list without customer details', async () => {
    const { w, washes } = await membershipWithWorker();
    const id = washes[0].id;
    expect((await admin.post(`/api/admin/bookings/${id}/cancel`, { reason: '' })).status).toBe(400);
    expectOk(await admin.post(`/api/admin/bookings/${id}/cancel`, { reason: 'Society water shutdown' }));
    const row = expectOk(await w.c.get('/api/worker/queue?days=60')).body.queue.find((q: any) => q.booking_id === id);
    expect(row).toMatchObject({ status: 'cancelled', bucket: 'changed', customer_name: null, customer_phone: null, society_name: null, flat_number: null, registration_number: null });
    expect(row.change).toMatchObject({ kind: 'cancelled', reason: 'Society water shutdown' });
    expect((await step(w.c, id, 'start')).status).toBeGreaterThanOrEqual(400);
  });

  it('admin reschedules a wash on a customer\'s behalf; the specialist sees it moved', async () => {
    const { w, washes } = await membershipWithWorker();
    const id = washes[0].id;
    expectOk(await admin.post(`/api/admin/bookings/${id}/reschedule`, { date: washes[0].scheduled_date, time_slot: 'afternoon', reason: 'Rain forecast' }));
    const row = expectOk(await w.c.get('/api/worker/queue?days=60')).body.queue.find((q: any) => q.booking_id === id);
    expect(row).toMatchObject({ time_slot: 'afternoon', status: 'worker_assigned' });
    expect(row.change).toMatchObject({ kind: 'rescheduled', by: 'admin' });
  });
});

describe('admin: assignment and oversight', () => {
  it('assigns one wash to a worker, who then sees it; reassigning tells the first worker it is no longer theirs', async () => {
    const a = await staffClient('worker');
    const b = await staffClient('worker');
    const m = await activeMembership({ admin });
    const wash = expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes[0];

    const unassigned = expectOk(await admin.get('/api/admin/bookings?unassigned=1&membership=' + m.membershipId)).body.bookings;
    expect(unassigned).toHaveLength(12);

    expectOk(await admin.post(`/api/admin/bookings/${wash.id}/assign`, { worker_profile_id: a.profileId }));
    expect(expectOk(await a.c.get('/api/worker/queue?days=60')).body.queue.map((q: any) => q.booking_id)).toEqual([wash.id]);
    expectOk(await admin.post(`/api/admin/bookings/${wash.id}/assign`, { worker_profile_id: b.profileId }));
    const aRow = expectOk(await a.c.get('/api/worker/queue?days=60')).body.queue[0];
    expect(aRow).toMatchObject({ bucket: 'changed', customer_name: null });
    expect(aRow.change.kind).toBe('reassigned');
    expect(expectOk(await b.c.get('/api/worker/queue?days=60')).body.queue.map((q: any) => q.booking_id)).toEqual([wash.id]);

    const row = expectOk(await admin.get(`/api/admin/bookings?membership=${m.membershipId}`)).body.bookings.find((x: any) => x.id === wash.id);
    expect(row).toMatchObject({ worker_id: b.profileId, status: 'worker_assigned', customer_name: 'Asha Kulkarni' });
    expect((await admin.post(`/api/admin/bookings/${wash.id}/assign`, { worker_profile_id: m.vehicle.id })).status).toBe(404); // not a specialist
  });

  it('a worker can claim an unclaimed paid wash from the pool, but not an unpaid or someone else\'s', async () => {
    const w = await staffClient('worker');
    const w2 = await staffClient('worker');
    const m = await activeMembership({ admin });
    const wash = expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes[0];
    const inPool = expectOk(await w.c.get('/api/worker/pool')).body.pool.map((p: any) => p.booking_id);
    expect(inPool).toContain(wash.id);
    const claimed = expectOk(await step(w.c, wash.id, 'claim')).body.wash;
    expect(claimed).toMatchObject({ status: 'worker_assigned', customer_name: 'Asha Kulkarni' });
    expect((await step(w2.c, wash.id, 'claim')).body.message).toMatch(/already assigned/);
    expect(expectOk(await w2.c.get('/api/worker/pool')).body.pool.map((p: any) => p.booking_id)).not.toContain(wash.id);
  });

  it('overview, memberships and specialists lists work for admins only', async () => {
    const { w, m } = await membershipWithWorker();
    const o = expectOk(await admin.get('/api/admin/overview')).body.overview;
    expect(o).toEqual(expect.objectContaining({ requests_to_quote: expect.any(Number), washes_today: expect.any(Number), active_memberships: expect.any(Number), unfulfilled_payments: expect.any(Number) }));
    const ms = expectOk(await admin.get('/api/admin/memberships')).body.memberships.find((x: any) => x.id === m.membershipId);
    expect(ms).toMatchObject({ status: 'active', worker_id: w.profileId, worker_name: 'Ravi Patil', customer_name: 'Asha Kulkarni', washes_total: 12, washes_completed: 0, frequency_per_week: 3 });
    const workers = expectOk(await admin.get('/api/admin/workers')).body.workers;
    expect(workers.find((x: any) => x.id === w.profileId).washes_next_7_days).toBeGreaterThanOrEqual(0);
    for (const p of ['/api/admin/overview', '/api/admin/memberships', '/api/admin/workers', '/api/admin/attention', '/api/admin/bookings']) {
      expect((await w.c.get(p)).status, p).toBe(403);
      expect((await m.c.get(p)).status, p).toBe(403);
    }
  });

  it('releasing a membership returns its washes to the pool', async () => {
    const { w, m } = await membershipWithWorker();
    expectOk(await admin.post(`/api/admin/memberships/${m.membershipId}/assign-worker`, { worker_profile_id: null }));
    const q = expectOk(await w.c.get('/api/worker/queue?days=60')).body.queue;
    expect(q.every((r: any) => r.bucket === 'changed' && r.customer_name === null)).toBe(true);
    expect(expectOk(await admin.get(`/api/admin/bookings?unassigned=1&membership=${m.membershipId}`)).body.bookings).toHaveLength(12);
  });
});

describe('admin: customers and specialists', () => {
  it('lists and searches customers', async () => {
    const cust = await customerWithVehicle();
    const all = expectOk(await admin.get('/api/admin/customers')).body.customers;
    expect(all.find((c: any) => c.phone === `+91${cust.phone}`)).toMatchObject({ full_name: 'Asha Kulkarni', vehicles: 1, active_memberships: 0 });
    const hit = expectOk(await admin.get(`/api/admin/customers?q=${cust.phone}`)).body.customers;
    expect(hit.map((c: any) => c.phone)).toEqual([`+91${cust.phone}`]);
    expect((await cust.c.get('/api/admin/customers')).status).toBe(403);
  });

  it('creates a specialist who can then sign in with the email and password', async () => {
    const email = `new-${Date.now()}@washo.test`;
    expect((await admin.post('/api/admin/workers', { full_name: 'Sunil More', email, phone: '9876500123', password: 'short' })).status).toBe(400);
    const created = expectOk(await admin.post('/api/admin/workers', { full_name: 'Sunil More', email, phone: '9876500123', password: 'Long-enough-1' })).body.worker;
    expect(created.full_name).toBe('Sunil More');
    const w = new Client();
    expect((await w.loginStaff(email, 'Long-enough-1')).body.role).toBe('worker');
    expectOk(await admin.put(`/api/admin/workers/${created.id}`, { full_name: 'Sunil R More', phone: '9876500124' }));
    expect(expectOk(await admin.get('/api/admin/workers')).body.workers.find((x: any) => x.id === created.id).full_name).toBe('Sunil R More');
    expect((await w.post('/api/admin/workers', { full_name: 'Evil', email: 'e@e.test', phone: '9876500125', password: 'Long-enough-1' })).status).toBe(403);
  });
});
