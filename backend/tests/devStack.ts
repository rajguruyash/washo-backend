/**
 * `npm run dev:stack`: the website API against a LOCAL stand-in for Supabase (Auth, edge functions, Storage) backed by a
 * real local copy of the WASHO database with every migration applied. For trying the site by hand. Not for production.
 *   Customer OTP is always 123456.  Admin: admin@washo.test / Admin-pass-1   Specialist: worker@washo.test / Worker-pass-1
 * Run `npm run dev` (Vite) in another terminal and open the URL it prints.
 */
import express from 'express';
import { FAKE, startFakeSupabase } from './fakeSupabase';

async function main() {
  const db = process.env.SB_TEST_DB!;
  const fake = await startFakeSupabase(db);
  process.env.SUPABASE_URL = fake.url;
  process.env.SUPABASE_ANON_KEY = FAKE.anonKey;
  process.env.SUPABASE_JWT_SECRET = FAKE.jwtSecret;
  process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE.serviceKey;
  process.env.RAZORPAY_KEY_ID = FAKE.razorpayKeyId;
  process.env.RAZORPAY_KEY_SECRET = FAKE.razorpayKeySecret;
  process.env.RAZORPAY_API_BASE = fake.razorpayBase;
  process.env.GEOCODE_URL = `${fake.url}/geo`; // "Use my location" answers from a stand-in, not OpenStreetMap
  process.env.GEOCODE_MIN_INTERVAL_MS = '0';
  process.env.DATABASE_URL = process.env.SB_API_DB_URL || `postgresql://washo_api:washo_api_test@localhost:5432/${db}`;
  process.env.PORT ||= '5001';

  await fake.createStaff('admin', { email: 'admin@washo.test', password: 'Admin-pass-1', name: 'WASHO Admin', phone: '9000000001' });
  await fake.createStaff('worker', { email: 'worker@washo.test', password: 'Worker-pass-1', name: 'Ravi Patil', phone: '9000000002' });

  const { createApp } = await import('../src/app');
  const { setMailTransport } = await import('../src/notify');
  const { config } = await import('../src/config');
  // No real email in dev: mail goes to a little inbox, read at GET /__dev/mail?to=<address> (newest first).
  const inbox: { to: string; subject: string; html: string }[] = [];
  setMailTransport(async (m) => { inbox.unshift(m); console.log(`[dev mail] to ${m.to}: ${m.subject}`); });
  // Dev-only helper so a browser stub of Razorpay Checkout can obtain the signed result Razorpay would return.
  const outer = express();
  outer.get('/__dev/checkout', (req, res) => {
    try {
      res.json(fake.checkout(String(req.query.order)));
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });
  outer.get('/__dev/mail', (req, res) => {
    const to = String(req.query.to ?? '').toLowerCase();
    res.json(inbox.filter((m) => !to || m.to.toLowerCase() === to));
  });
  outer.use(createApp());
  outer.listen(config.port, () => {
    console.log(`\nWASHO API on http://localhost:${config.port}  (fake Supabase at ${fake.url})`);
    console.log('Customer OTP: 123456 · Admin: admin@washo.test / Admin-pass-1 · Specialist: worker@washo.test / Worker-pass-1');
    console.log('Razorpay is simulated: GET /__dev/checkout?order=<order_id> returns what Checkout would send to /api/payments/verify.\n');
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
