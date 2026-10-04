import { config } from './config';
import { HttpError } from './errors';

/**
 * The only places this server talks to Supabase over HTTP:
 *   - Auth (phone OTP via Twilio Verify, Google sign-in, email + password: all configured inside Supabase)
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

  /**
   * Where to send the browser for "Continue with Google". PKCE: Supabase hands back a one-time code, which only the holder of
   * the matching verifier (kept in an httpOnly cookie on this server) can exchange. No token ever appears in a URL.
   */
  googleAuthorizeUrl(redirectTo: string, challenge: string): string {
    const q = new URLSearchParams({ provider: 'google', redirect_to: redirectTo, code_challenge: challenge, code_challenge_method: 's256' });
    return `${config.supabase.url}/auth/v1/authorize?${q}`;
  },

  async exchangeCode(code: string, verifier: string): Promise<AuthSession> {
    const { status, body } = await auth('/token?grant_type=pkce', { method: 'POST', body: JSON.stringify({ auth_code: code, code_verifier: verifier }) });
    if (status < 300 && body.access_token) return body as AuthSession;
    if (status >= 500) throw new HttpError(503, 'auth_unavailable', 'Sign-in is unavailable right now. Please try again shortly.');
    throw new HttpError(400, 'bad_code', 'That sign-in link has expired. Please try again.');
  },

  /** A signed-in person adds a mobile number: Supabase texts a code to the NEW number (it is not theirs until they confirm it). */
  async requestPhoneChange(accessToken: string, phone: string): Promise<void> {
    const { status, body } = await auth('/user', { method: 'PUT', bearer: accessToken, body: JSON.stringify({ phone }) });
    if (status < 300) return;
    const code = String(body.error_code || body.code || '');
    if (code === 'phone_exists') {
      throw new HttpError(409, 'phone_taken', 'That number is already registered with WASHO. Sign in with that number instead.');
    }
    if (status === 429 || code.includes('rate_limit')) throw new HttpError(429, 'otp_cooldown', 'Please wait a minute before asking for another code.');
    if (status === 401) throw new HttpError(401, 'unauthenticated', 'Please sign in to continue.');
    if (code === 'phone_provider_disabled' || code === 'sms_send_failed' || status >= 500) {
      console.error('Phone change failed:', status, code, body.msg || body.message);
      throw new HttpError(503, 'otp_unavailable', 'We cannot send codes right now. Please try again shortly.');
    }
    throw new HttpError(400, 'otp_invalid_phone', 'We could not send a code to that number.');
  },

  async verifyPhoneChange(accessToken: string, phone: string, token: string): Promise<AuthSession> {
    const { status, body } = await auth('/verify', { method: 'POST', bearer: accessToken, body: JSON.stringify({ type: 'phone_change', phone, token }) });
    if (status < 300 && body.access_token) return body as AuthSession;
    if (status === 429) throw new HttpError(429, 'otp_limit', 'Too many attempts. Please wait a few minutes.');
    if (status >= 500) throw new HttpError(503, 'otp_unavailable', 'Sign-in is unavailable right now. Please try again shortly.');
    throw new HttpError(400, 'otp_invalid', "That code isn't right, or it has expired. Check it or ask for a new one.");
  },

  async refresh(refreshToken: string): Promise<AuthSession | null> {
    const { status, body } = await auth('/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) });
    return status < 300 && body.access_token ? (body as AuthSession) : null;
  },

  async logout(accessToken: string): Promise<void> {
    await auth('/logout?scope=local', { method: 'POST', bearer: accessToken }).catch(() => undefined);
  },
};

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
