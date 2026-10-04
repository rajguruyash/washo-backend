import { config } from './config';
import { HttpError } from './errors';

/**
 * The only places this server talks to Supabase over HTTP:
 *   - Auth (phone OTP via Twilio Verify, which is configured inside Supabase)
 *   - the Razorpay edge functions, called with the CUSTOMER'S OWN token (so the database applies their identity)
 *   - Storage, for wash photos
 */

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; phone?: string; email?: string };
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function auth(path: string, init: RequestInit & { bearer?: string } = {}): Promise<{ status: number; body: any }> {
  const { bearer, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${config.supabase.url}/auth/v1${path}`, {
      ...rest,
      headers: {
        apikey: config.supabase.anonKey,
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
  } catch (err) {
    console.error('Supabase Auth unreachable:', (err as Error).message);
    throw new HttpError(503, 'auth_unavailable', 'Sign-in is unavailable right now. Please try again shortly.');
  }
  return { status: res.status, body: await readJson(res) };
}

export const gotrue = {
  /** Sends an SMS code. Supabase decides throttling; its answer is passed through in plain language. */
  async sendOtp(phone: string): Promise<void> {
    const { status, body } = await auth('/otp', { method: 'POST', body: JSON.stringify({ phone, create_user: true, channel: 'sms' }) });
    if (status < 300) return;
    const code = String(body.error_code || body.code || '');
    if (status === 429 || code.includes('rate_limit')) {
      throw new HttpError(429, 'otp_cooldown', 'Please wait a minute before asking for another code.');
    }
    if (code === 'phone_provider_disabled' || code === 'sms_send_failed' || status >= 500) {
      console.error('OTP send failed:', status, code, body.msg || body.message);
      throw new HttpError(503, 'otp_unavailable', 'We cannot send codes right now. Please try again shortly.');
    }
    throw new HttpError(400, 'otp_invalid_phone', 'We could not send a code to that number.');
  },

  async verifyOtp(phone: string, token: string): Promise<AuthSession> {
    const { status, body } = await auth('/verify', { method: 'POST', body: JSON.stringify({ type: 'sms', phone, token }) });
    if (status < 300 && body.access_token) return body as AuthSession;
    if (status === 429) throw new HttpError(429, 'otp_limit', 'Too many attempts. Please wait a few minutes.');
    if (status >= 500) throw new HttpError(503, 'otp_unavailable', 'Sign-in is unavailable right now. Please try again shortly.');
    throw new HttpError(400, 'otp_invalid', "That code isn't right, or it has expired. Check it or ask for a new one.");
  },

  /** Staff (specialists and WASHO admins) have email + password accounts, created by admin_create_worker. */
  async passwordLogin(email: string, password: string): Promise<AuthSession> {
    const { status, body } = await auth('/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (status < 300 && body.access_token) return body as AuthSession;
    if (status === 429) throw new HttpError(429, 'login_limit', 'Too many attempts. Please wait a few minutes.');
    if (status >= 500) throw new HttpError(503, 'auth_unavailable', 'Sign-in is unavailable right now. Please try again shortly.');
    throw new HttpError(401, 'bad_credentials', 'Email or password is incorrect.');
  },

  async refresh(refreshToken: string): Promise<AuthSession | null> {
    const { status, body } = await auth('/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) });
    return status < 300 && body.access_token ? (body as AuthSession) : null;
  },

  async logout(accessToken: string): Promise<void> {
    await auth('/logout?scope=local', { method: 'POST', bearer: accessToken }).catch(() => undefined);
  },
};

/** Calls a Supabase edge function as the signed-in customer. The function (and the database behind it) decide everything. */
export async function invokeFunction<T = any>(name: string, body: unknown, accessToken: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.supabase.url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: config.supabase.anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`Edge function ${name} unreachable:`, (err as Error).message);
    throw new HttpError(503, 'payments_unavailable', 'Payments are unavailable right now. Please try again shortly.');
  }
  const payload = await readJson(res);
  if (res.ok) return payload as T;
  const message = typeof payload.error === 'string' ? payload.error : 'Something went wrong. Please try again.';
  throw new HttpError(res.status === 401 ? 401 : res.status >= 500 ? 502 : 422, 'payment_error', message);
}

// ───────────────────────── Storage (wash photos) ─────────────────────────
function storageHeaders(extra: Record<string, string> = {}) {
  const key = config.supabase.serviceRoleKey;
  if (!key) throw new HttpError(503, 'storage_unavailable', 'Photo storage is not configured.');
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export const photoStorage = {
  async upload(path: string, bytes: Buffer, contentType: string): Promise<void> {
    const res = await fetch(`${config.supabase.url}/storage/v1/object/${config.supabase.photoBucket}/${encodePath(path)}`, {
      method: 'POST',
      headers: storageHeaders({ 'Content-Type': contentType, 'x-upsert': 'false' }),
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      console.error('Photo upload failed:', res.status, await res.text().catch(() => ''));
      throw new HttpError(502, 'upload_failed', 'The photo could not be saved. Please try again.');
    }
  },

  /** A short-lived link. The bucket itself may be private; only people the database authorised ever get one. */
  async signedUrl(path: string, seconds = config.photos.signedUrlSeconds): Promise<string | null> {
    const res = await fetch(`${config.supabase.url}/storage/v1/object/sign/${config.supabase.photoBucket}/${encodePath(path)}`, {
      method: 'POST',
      headers: storageHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: seconds }),
    });
    if (!res.ok) return null;
    const body = (await readJson(res)) as { signedURL?: string; signedUrl?: string };
    const rel = body.signedURL || body.signedUrl;
    if (!rel) return null;
    if (/^https?:/.test(rel)) return rel;
    return `${config.supabase.url}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}`;
  },
};
