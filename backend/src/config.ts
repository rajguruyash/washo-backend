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
 * The language-model services set up in the environment, in the order they are tried (see the `agent` block below). A service may list several models (GEMINI_MODEL=a,b): they are tried in
 * that order, and Gemini sets its free limits per model, so the second one should still answer when the first has used up its own.
 */
export function agentProviders(env: NodeJS.ProcessEnv = process.env): { name: string; baseUrl: string; apiKey: string; model: string; reasoning?: string }[] {
  const models = (list: string | undefined, fallback: string) => (list || fallback).split(',').map((m) => m.trim()).filter(Boolean);
  const presets: Record<string, { baseUrl: string; key: string; models: string[]; reasoning: string }> = {
    // Google retired gemini-2.5-flash for new projects. 3.5 Flash-Lite is the fast, cheap one (first); 3.8 Flash is the larger one (second). Check the list your key can use: see docs/AGENT.md.
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', key: env.GEMINI_API_KEY || '', models: models(env.GEMINI_MODEL, 'gemini-3.5-flash-lite,gemini-3.8-flash'), reasoning: env.GEMINI_REASONING || 'minimal' },
    groq: { baseUrl: 'https://api.groq.com/openai/v1', key: env.GROQ_API_KEY || '', models: models(env.GROQ_MODEL, 'openai/gpt-oss-120b'), reasoning: env.GROQ_REASONING || 'low' },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: env.OPENROUTER_API_KEY || '', models: models(env.OPENROUTER_MODEL, 'openrouter/free'), reasoning: env.OPENROUTER_REASONING || 'off' },
  };
  const all = [
    ...(env.AGENT_BASE_URL && env.AGENT_MODEL ? models(env.AGENT_MODEL, '').map((model) => ({ name: 'custom', baseUrl: env.AGENT_BASE_URL!.trim(), apiKey: (env.AGENT_API_KEY || '').trim(), model, reasoning: env.AGENT_REASONING || 'off' })) : []),
    ...Object.entries(presets).filter(([, p]) => p.key.trim()).flatMap(([name, p]) => p.models.map((model) => ({ name, baseUrl: p.baseUrl, apiKey: p.key.trim(), model, reasoning: p.reasoning }))),
  ];
  const wanted = (env.AGENT_PROVIDERS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return wanted.length ? wanted.flatMap((n) => all.filter((p) => p.name === n)) : all;
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

  // Admin sign-in has a second step (a code emailed to the admin). What proves the step was done is a cookie signed with this secret, so it cannot be made
  // without this server. Set ADMIN_2FA_SECRET to your own long random value; if it is not set the secret is derived from the service-role key
  // (which this server must hold anyway). With neither, admins cannot sign in at all (the server never falls back to a password alone).
  admin: {
    secret: process.env.ADMIN_2FA_SECRET || '',
    // Signed out after this many minutes without any request, and always after twelve hours.
    idleMinutes: Math.max(5, Number(process.env.ADMIN_IDLE_MINUTES) || 30),
    // This account is always the super admin, whatever the roles table says, so a mistake there can never lock the owner out.
    superEmail: (process.env.SUPER_ADMIN_EMAIL || 'rajguruyash29@gmail.com').trim().toLowerCase(),
    // Optional, and meant to be TEMPORARY. Resend only delivers to arbitrary inboxes once the sender domain is verified; until then it may refuse to mail the
    // admin's own address. Setting this sends EVERY admin's sign-in code to this one inbox (one the owner reads) instead, so the second step still works and
    // nobody is locked out. Remove it once the domain is verified.
    codeTo: (process.env.ADMIN_CODE_TO || '').trim().toLowerCase(),
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

  // Push to a closed phone (Firebase Cloud Messaging). Put the service-account key of the Firebase project in Render as FIREBASE_SERVICE_ACCOUNT_JSON (the whole JSON file, or that
  // file base64-encoded); FIREBASE_SERVICE_ACCOUNT_FILE (a path) is for trying it on a computer. Not set: nothing is pushed, everything else works. Only tests set FCM_API_BASE.
  push: {
    serviceAccountJson: (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim(),
    serviceAccountFile: (process.env.FIREBASE_SERVICE_ACCOUNT_FILE || '').trim(),
    fcmBase: (process.env.FCM_API_BASE || 'https://fcm.googleapis.com').replace(/\/+$/, ''),
  },

  // Woshi, the booking assistant. It talks to any free (or paid) language-model service that speaks the common chat API; put the key of one or more in Render and it is switched on.
  // Several can be set: when the first is out of its free allowance, the next answers. In the order tried (or choose with AGENT_PROVIDERS="gemini,groq"):
  //   AGENT_BASE_URL (+ AGENT_API_KEY, AGENT_MODEL)  your own: a model on your computer (Ollama: http://localhost:11434/v1) or any compatible service
  //   GEMINI_API_KEY      Google Gemini free tier (aistudio.google.com/apikey)        GEMINI_MODEL, default gemini-2.5-flash
  //   GROQ_API_KEY        Groq free plan (console.groq.com/keys)                       GROQ_MODEL, default openai/gpt-oss-120b
  //   OPENROUTER_API_KEY  OpenRouter free models (openrouter.ai/keys)                  OPENROUTER_MODEL, default openrouter/free
  // AGENT_ENABLED=false switches the assistant off without removing a key. The limits protect free allowances (and any bill).
  agent: {
    providers: agentProviders(),
    enabled: process.env.AGENT_ENABLED !== 'false',
    // AGENT_MODE=rules never calls a model (fixed questions and answers only). Otherwise the model is used, and simple mode takes over only while no model can be reached.
    // Buttons (Book a single wash, Prices...) are answered by the fixed rules without calling a model: instant, and it spares a small free allowance. AGENT_RULES_FIRST=false sends them to the model too.
    rulesFirst: process.env.AGENT_RULES_FIRST !== 'false',
    mode: process.env.AGENT_MODE === 'rules' ? ('rules' as 'rules' | 'auto') : ('auto' as 'rules' | 'auto'),
    // After simple mode began, and between booking flows, the model is tried again after this long.
    retryModelMs: Number(process.env.AGENT_RETRY_MODEL_MS ?? 180_000),
    // A free model can be answering, but too slowly for a chat. When one message takes longer than this (0 turns the check off), simple mode answers for the next few minutes, then the model is tried again.
    slowTurnMs: Number(process.env.AGENT_SLOW_TURN_MS ?? 20_000),
    slowRestMs: Number(process.env.AGENT_SLOW_REST_MS ?? 300_000),
    messagesPer5Min: Number(process.env.AGENT_MESSAGES_PER_5_MIN || 15),
    messagesPerDay: Number(process.env.AGENT_MESSAGES_PER_DAY || 60),
    // Messages answered by the fixed rules cost nothing but a few database reads, so they have their own, much larger allowance.
    rulesPer5Min: Number(process.env.AGENT_RULES_PER_5_MIN || 100),
    rulesPerDay: Number(process.env.AGENT_RULES_PER_DAY || 1500),
    tokensPerDay: Number(process.env.AGENT_TOKENS_PER_USER_DAY || 150_000),
    callsPerDay: Number(process.env.AGENT_CALLS_PER_DAY || 800),
  },

  // Optional. When set, an outside scheduler (Render Cron Job, cron-job.org, GitHub Actions) can call POST /api/cron/reminders with
  // `Authorization: Bearer <this>`. The site also runs the reminders itself every hour while it is awake, so this is only a safety net.
  cronSecret: process.env.CRON_SECRET || '',

  photos: {
    maxBytes: 8 * 1024 * 1024,
    signedUrlSeconds: 15 * 60,
  },
} as const;
