import crypto from 'crypto';
import fs from 'fs';
import { config } from './config';

/**
 * Push to a phone whose app is closed, through Firebase Cloud Messaging (the HTTP v1 API). The server proves who it is with the Firebase project's service-account key (a signed
 * request for a short-lived access token), then sends one message per phone. Nothing here knows about customers: callers pass the phones' tokens and the words.
 * Not configured (no key in the server's environment): `pushConfigured()` is false and nothing is sent; callers carry on without it.
 */
export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** Extra values the app reads when the notification is tapped (strings only). */
  data?: Record<string, string>;
}
/** What happened to one message: delivered to Firebase, the phone is gone (remove its token), or it failed for another reason (try again later). */
export type PushResult = 'sent' | 'dead' | 'failed';
type Transport = (messages: PushMessage[]) => Promise<PushResult[]>;

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const CHANNEL = 'washo'; // the Android channel the app creates (src/lib/notify.ts)
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

/** The key from the environment: the JSON itself, that JSON base64-encoded, or a file path. Returns null when none is set or it is not a usable key. */
export function readServiceAccount(src = config.push): ServiceAccount | null {
  try {
    let raw = src.serviceAccountJson;
    if (raw && !raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    if (!raw && src.serviceAccountFile) raw = fs.readFileSync(src.serviceAccountFile, 'utf8');
    if (!raw) return null;
    const sa = JSON.parse(raw) as Partial<ServiceAccount>;
    if (!sa.project_id || !sa.client_email || !sa.private_key) return null;
    return { project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri };
  } catch {
    return null;
  }
}

/** The real transport: Firebase Cloud Messaging with a service-account key. `apiBase` is only different in tests. */
export function fcmTransport(sa: ServiceAccount, apiBase = config.push.fcmBase): Transport {
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  let access: { value: string; expires: number } | null = null;

  // Sends start together: they share ONE sign-in instead of each asking Google for its own access token.
  let signingIn: Promise<string> | null = null;
  function accessToken(): Promise<string> {
    if (access && access.expires > Date.now() + 60_000) return Promise.resolve(access.value);
    signingIn ??= signIn().finally(() => void (signingIn = null));
    return signingIn;
  }

  async function signIn(): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 }))}`;
    const assertion = `${unsigned}.${b64url(crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key))}`;
    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !j.access_token) throw new Error(`Firebase sign-in failed (${res.status})`);
    access = { value: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return access.value;
  }

  async function sendOne(m: PushMessage, retry = true): Promise<PushResult> {
    try {
      const res = await fetch(`${apiBase}/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: m.token,
            notification: { title: m.title.slice(0, 80), body: m.body.slice(0, 500) },
            data: m.data ?? {},
            android: { priority: 'HIGH', ttl: '86400s', notification: { channel_id: CHANNEL } },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return 'sent';
      if (res.status === 401 && retry) {
        access = null; // the access token was refused (expired early): sign in again once
        return sendOne(m, false);
      }
      const j = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } };
      const code = j.error?.details?.find((d) => d.errorCode)?.errorCode;
      // the phone no longer has the app (or the token was never valid): its token is worth nothing
      if (res.status === 404 || code === 'UNREGISTERED' || (res.status === 400 && (code === 'INVALID_ARGUMENT' || /registration token/i.test(j.error?.message ?? '')))) return 'dead';
      return 'failed';
    } catch {
      return 'failed';
    }
  }

  return async (messages) => {
    const out: PushResult[] = new Array(messages.length);
    let next = 0;
    // a few at a time: fast enough for a few thousand phones, gentle on Firebase and on this server
    await Promise.all(
      Array.from({ length: Math.min(20, messages.length) }, async () => {
        while (next < messages.length) {
          const i = next++;
          out[i] = await sendOne(messages[i]);
        }
      })
    );
    return out;
  };
}

const account = readServiceAccount();
let transport: Transport | null = account ? fcmTransport(account) : null;
/** Tests swap in their own (as with mail). */
export const setPushTransport = (t: Transport | null) => void (transport = t);
export const pushConfigured = () => transport !== null;

/** Sends the messages. Never throws: a failure is reported per message. Not configured: everything is reported as not sent. */
export async function sendPush(messages: PushMessage[]): Promise<PushResult[]> {
  if (!transport || !messages.length) return messages.map(() => 'failed' as const);
  try {
    return await transport(messages);
  } catch (err) {
    console.error('Push failed:', err instanceof Error ? err.message : err);
    return messages.map(() => 'failed' as const);
  }
}
