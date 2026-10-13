/**
 * Pictures in a complaint over HTTP: the support admin adds pictures to a reply, the customer sees them (as short-lived links to the real file) on their own complaint, and
 * nobody else can add or see them. Storage is a local stand-in; the database is real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, JPEG, PNG, boot, customerWithVehicle, expectOk, fake, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const upload = (c: Client, id: string, bytes: Buffer = JPEG, contentType = 'image/jpeg') =>
  c.req('POST', `/api/admin/support/${id}/attachments`, undefined, { raw: bytes, contentType });
async function complaint() {
  const cust = await customerWithVehicle('car');
  const t = expectOk(await cust.c.post('/api/support', { category: 'booking', subject: 'Wash not done', message: 'Nobody came today at all' })).body.ticket as { id: string };
  return { cust, id: t.id };
}

describe('adding and sending pictures', () => {
  it('the support admin adds pictures and sends them with a reply; the customer sees them, and the links open the real files', async () => {
    const { cust, id } = await complaint();
    const sup = await staffClient('admin', { access: 'support' });
    const a = expectOk(await upload(sup.c, id)).body;
    const b = expectOk(await upload(sup.c, id, PNG, 'image/png')).body;
    expect(a.url).toMatch(/\/storage\/v1\/object\/sign\/wash-photos\/.+\?token=/);
    // not sent yet: the customer sees none
    expect((expectOk(await cust.c.get(`/api/support/${id}`)).body.messages as any[]).every((m) => m.attachments.length === 0)).toBe(true);

    expectOk(await sup.c.post(`/api/admin/support/${id}/reply`, { message: 'Sorry about that. Here is what we found.', status: 'resolved', picture_ids: [a.id, b.id] }));
    const seen = expectOk(await cust.c.get(`/api/support/${id}`)).body;
    const last = seen.messages[seen.messages.length - 1];
    expect(last).toMatchObject({ from_admin: true, body: 'Sorry about that. Here is what we found.' });
    expect(last.attachments).toHaveLength(2);
    for (const p of last.attachments) {
      expect(p.url).toMatch(/\/storage\/v1\/object\/sign\/wash-photos\/.+\?token=/);
      expect(Object.keys(p).sort()).toEqual(['content_type', 'id', 'url']);   // the file path never leaves the server
      expect((await fetch(p.url)).status).toBe(200);
    }
    expect(seen.messages[0].attachments).toEqual([]);
    // the admin's own thread shows them too
    const adminSees = expectOk(await sup.c.get(`/api/admin/support/${id}`)).body;
    expect(adminSees.messages[adminSees.messages.length - 1].attachments).toHaveLength(2);
    // stored in the complaint's own folder
    const keys = Array.from(fake.objects.keys()).filter((k) => k.includes(`${id}/support-`));
    expect(keys).toHaveLength(2);
  });

  it('a reply without pictures is unchanged; the same picture cannot be sent twice; more than 4 are refused', async () => {
    const { cust, id } = await complaint();
    const sup = await staffClient('admin', { access: 'support' });
    expectOk(await sup.c.post(`/api/admin/support/${id}/reply`, { message: 'We are looking into it' }));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(expectOk(await upload(sup.c, id)).body.id);
    const tooMany = await sup.c.post(`/api/admin/support/${id}/reply`, { message: 'Too many', picture_ids: ids });
    expect(tooMany.status).toBe(400);
    expect(JSON.stringify(tooMany.body)).toMatch(/up to 4 pictures/);
    expectOk(await sup.c.post(`/api/admin/support/${id}/reply`, { message: 'Four of them', picture_ids: ids.slice(0, 4) }));
    const again = await sup.c.post(`/api/admin/support/${id}/reply`, { message: 'Again', picture_ids: [ids[0]] });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.body.message).toMatch(/could not be found/);
    const seen = expectOk(await cust.c.get(`/api/support/${id}`)).body.messages as any[];
    expect(seen.filter((m) => m.from_admin).map((m) => m.attachments.length)).toEqual([0, 4]);
  });

  it('only JPG, PNG and WebP pictures, within the size limit', async () => {
    const { id } = await complaint();
    const sup = await staffClient('admin', { access: 'support' });
    const text = await upload(sup.c, id, Buffer.from('not a picture at all, just words'), 'image/jpeg');
    expect(text.status).toBe(415);
    expect(text.body.message).toMatch(/JPG, PNG or WebP/);
    const pdf = await sup.c.req('POST', `/api/admin/support/${id}/attachments`, undefined, { raw: Buffer.from('%PDF-1.4 blah blah blah'), contentType: 'application/pdf' });
    expect(pdf.status).toBeGreaterThanOrEqual(400);
    expect((await upload(sup.c, id, Buffer.alloc(0))).status).toBeGreaterThanOrEqual(400);
    const huge = await upload(sup.c, id, Buffer.concat([JPEG, Buffer.alloc(9 * 1024 * 1024)]));
    expect(huge.status).toBeGreaterThanOrEqual(400);
    expect(Array.from(fake.objects.keys()).filter((k) => k.includes(`${id}/support-`))).toHaveLength(0);   // nothing was stored
  });

  it('a closed complaint takes no more pictures, and nothing is stored for the refusal', async () => {
    const { id } = await complaint();
    const sup = await staffClient('admin', { access: 'support' });
    expectOk(await sup.c.post(`/api/admin/support/${id}/status`, { status: 'closed' }));
    const r = await upload(sup.c, id);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.message).toMatch(/closed/);
    expect(Array.from(fake.objects.keys()).filter((k) => k.includes(`${id}/support-`))).toHaveLength(0);
  });
});

describe('who may', () => {
  it('only an admin with the support role can add pictures or send them', async () => {
    const { cust, id } = await complaint();
    const other = await customerWithVehicle('car');
    const worker = await staffClient('worker');
    const fin = await staffClient('admin', { access: 'finance' });
    const ops = await staffClient('admin', { access: 'operations' });
    for (const [who, label] of [[cust.c, 'the customer'], [other.c, 'another customer'], [worker.c, 'a specialist'], [fin.c, 'finance'], [ops.c, 'operations'], [new Client(), 'nobody']] as const) {
      expect((await upload(who, id)).status, label).toBeGreaterThanOrEqual(401);
      expect((await who.post(`/api/admin/support/${id}/reply`, { message: 'x', picture_ids: [] })).status, label).toBeGreaterThanOrEqual(401);
    }
    expect(Array.from(fake.objects.keys()).filter((k) => k.includes(`${id}/support-`))).toHaveLength(0);
    // a super admin may
    const owner = await staffClient('admin', { access: 'super_admin' });
    expectOk(await upload(owner.c, id));
  });

  it('another customer cannot open the complaint or its pictures', async () => {
    const { id } = await complaint();
    const sup = await staffClient('admin', { access: 'support' });
    const p = expectOk(await upload(sup.c, id)).body;
    expectOk(await sup.c.post(`/api/admin/support/${id}/reply`, { message: 'See the picture', picture_ids: [p.id] }));
    const other = await customerWithVehicle('car');
    const r = await other.c.get(`/api/support/${id}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.body)).not.toContain('support-');
  });
});
