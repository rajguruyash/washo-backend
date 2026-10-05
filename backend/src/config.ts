import 'dotenv/config';

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

function required(name: string, devFallback?: string): string {
  const value = process.env[name];
  if (value) return value;
  if (!isProd && devFallback !== undefined) return devFallback;
  throw new Error(`Missing required environment variable ${name}`);
}

/**
 * Everything here points at SUPABASE, the one backend WASHO runs on. This server holds no business data
 * and no business rules of its own: it signs people in through Supabase Auth, calls the database's
 * functions as the signed-in person, and relays the Razorpay edge functions.
 */
export const config = {
  env,
  isProd,
  port: Number(process.env.PORT) || 5000,
  // The public address of the site (https://washo.online). Only needed so "Continue with Google" can tell Supabase where to
  // send people back to; when it is not set the address of the incoming request is used.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  supabase: {
    // The project URL. Local `supabase start` listens on 54321.
    url: required('SUPABASE_URL', 'http://127.0.0.1:54321').replace(/\/+$/, ''),
    // The public (publishable/anon) key: needed to talk to Supabase Auth. Safe to hold; it is not a secret.
    anonKey: required('SUPABASE_ANON_KEY', 'dev-anon-key'),
    // Legacy HS256 projects: the JWT secret. Projects on asymmetric signing keys leave this empty and the
    // server verifies tokens against the project's published JWKS instead.
    jwtSecret: process.env.SUPABASE_JWT_SECRET || '',
    // SERVER ONLY. Used for one thing: writing wash photos to Storage after the database has confirmed the
    // worker holds that wash, and signing short-lived URLs to view them. Never sent to a browser.
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    photoBucket: process.env.SUPABASE_PHOTO_BUCKET || 'wash-photos',
  },

  database: {
    // Supabase connection pooler URL for the least-privilege `washo_api` role (NOT the postgres superuser).
    url: required('DATABASE_URL', 'postgresql://washo_api@localhost:5432/postgres'),
    // off | require | verify. Defaults to off for localhost and "require" (encrypted) elsewhere.
    ssl: (process.env.DATABASE_SSL as 'require' | 'verify' | 'off' | undefined) || undefined,
  },

  // Razorpay Standard Checkout. Set both in the server's environment (Render). The secret never reaches the browser.
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    // Razorpay → Settings → Webhooks: the secret you typed there. Lets Razorpay tell us about a payment even if the customer's browser never did.
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    get configured() {
      return Boolean(this.keyId && this.keySecret);
    },
    // Only tests point this somewhere else (a local stand-in for Razorpay's API).
    apiBase: (process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com').replace(/\/+$/, ''),
  },

  email: {
    resendKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || 'WASHO <notifications@washo.online>',
    adminEmail: process.env.ADMIN_EMAIL || 'contact.washo@gmail.com',
  },

  // "Use my location" on the address form: a reverse lookup of the coordinates through OpenStreetMap's Nominatim (free; its usage policy asks
  // for an identifying User-Agent and at most one request a second, both done here). Only tests point `url` somewhere else.
  geocode: {
    url: (process.env.GEOCODE_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, ''),
    minIntervalMs: process.env.GEOCODE_MIN_INTERVAL_MS !== undefined ? Number(process.env.GEOCODE_MIN_INTERVAL_MS) : 1100,
  },

  photos: {
    maxBytes: 8 * 1024 * 1024,
    signedUrlSeconds: 15 * 60,
  },
} as const;
