import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importLeads } from '../scripts/import-leads';
import { DB } from './helpers';

const LEGACY = 'washo_legacy_leads_test';
const TARGET = 'washo_leads_target_test';
const url = (db: string) => `postgresql://localhost:5432/${db}`;
const admin = () => new Client({ database: 'postgres' });

beforeAll(async () => {
  const c = admin();
  await c.connect();
  for (const db of [LEGACY, TARGET]) await c.query(`DROP DATABASE IF EXISTS ${db}`);
  await c.query(`CREATE DATABASE ${LEGACY}`);
  await c.query(`CREATE DATABASE ${TARGET} TEMPLATE ${DB}`); // an exact copy of the migrated schema
  await c.end();
  const l = new Client({ connectionString: url(LEGACY) });
  await l.connect();
  // Exactly the old Render table, including its quirks.
  await l.query(`CREATE TABLE leads (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL, mobile VARCHAR(50) NOT NULL,
    vehicle_type VARCHAR(50) NOT NULL, vehicle_model VARCHAR(50) NOT NULL, vehicle_registration_number VARCHAR(50) NOT NULL, location VARCHAR(255) NOT NULL,
    flat_number VARCHAR(50) NOT NULL, preferred_service VARCHAR(100) NOT NULL, payment_image_url TEXT, status VARCHAR(50) DEFAULT 'Pending',
    source VARCHAR(50) DEFAULT 'website', timestamp VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await l.query(`INSERT INTO leads (name,email,mobile,vehicle_type,vehicle_model,vehicle_registration_number,location,flat_number,preferred_service,payment_image_url,status,source)
    VALUES ('Asha Rao','asha@example.com','9876500001','Car','Swift','MH12AB1111','Yashwin Orizzonte - A Wing','A-101','Car Basic','/uploads/payment-1.PNG','Scheduled','nfc'),
           ('Ravi K','ravi@example.com','9876500002','Bike','Activa','MH12CD2222','Yashwin Orizzonte - B Wing','B-202','Free Wash',NULL,'Pending','website')`);
  await l.end();
});
afterAll(async () => {
  const c = admin();
  await c.connect();
  for (const db of [LEGACY, TARGET]) await c.query(`DROP DATABASE IF EXISTS ${db}`);
  await c.end();
});

const count = async (db: string, sql: string) => {
  const c = new Client({ connectionString: url(db) });
  await c.connect();
  const r = await c.query(sql);
  await c.end();
  return r.rows;
};

describe('legacy lead import', () => {
  it('dry run reports what it would do and writes nothing', async () => {
    const r = await importLeads({ legacyUrl: url(LEGACY), targetUrl: url(TARGET), apply: false });
    expect(r).toEqual({ legacyRows: 2, alreadyImported: 0, toImport: 2, imported: 0 });
    expect((await count(TARGET, 'select count(*)::int n from public.website_leads'))[0].n).toBe(0);
  });

  it('--apply imports every lead, preserving the original fields, source and screenshot path', async () => {
    const r = await importLeads({ legacyUrl: url(LEGACY), targetUrl: url(TARGET), apply: true });
    expect(r).toMatchObject({ legacyRows: 2, imported: 2 });
    const rows = await count(TARGET, `select legacy_id, name, mobile, vehicle_registration_number, preferred_service, status, source, legacy_payment_image_url from public.website_leads order by legacy_id`);
    expect(rows[0]).toEqual({ legacy_id: 1, name: 'Asha Rao', mobile: '9876500001', vehicle_registration_number: 'MH12AB1111', preferred_service: 'Car Basic', status: 'Scheduled', source: 'nfc', legacy_payment_image_url: '/uploads/payment-1.PNG' });
    expect(rows[1].source).toBe('website');
  });

  it('is idempotent: re-running (even after new leads arrive) never duplicates', async () => {
    const again = await importLeads({ legacyUrl: url(LEGACY), targetUrl: url(TARGET), apply: true });
    expect(again).toMatchObject({ alreadyImported: 2, imported: 0 });
    await count(LEGACY, `insert into leads (name,email,mobile,vehicle_type,vehicle_model,vehicle_registration_number,location,flat_number,preferred_service) values ('New','n@x.com','9000000003','Car','i10','MH12EF3333','Somewhere','C-1','Car Pro') returning id`);
    const next = await importLeads({ legacyUrl: url(LEGACY), targetUrl: url(TARGET), apply: true });
    expect(next).toMatchObject({ alreadyImported: 2, imported: 1 });
    expect((await count(TARGET, 'select count(*)::int n from public.website_leads'))[0].n).toBe(3);
  });

  it('never modifies the legacy database', async () => {
    expect((await count(LEGACY, 'select count(*)::int n from leads'))[0].n).toBe(3);
    expect((await count(LEGACY, 'select status from leads order by id')).map((r) => r.status)).toEqual(['Scheduled', 'Pending', 'Pending']);
    expect((await count(LEGACY, `select payment_image_url from leads where id = 1`))[0].payment_image_url).toBe('/uploads/payment-1.PNG');
  });

  it('leads are admin-only inside Supabase', async () => {
    const c = new Client({ connectionString: url(TARGET) });
    await c.connect();
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE anon');
    await expect(c.query('select * from public.website_leads')).rejects.toThrow(/permission denied/);
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query(`select set_config('request.jwt.claims', '{"sub":"${'00000000-0000-0000-0000-000000000001'}"}', true)`);
    expect((await c.query('select * from public.website_leads')).rows).toHaveLength(0); // RLS: not an admin
    await c.query('ROLLBACK');
    await c.end();
  });
});
