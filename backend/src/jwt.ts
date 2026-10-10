import crypto from 'crypto';
import { config } from './config';

export interface VerifiedToken {
  sub: string;
  phone?: string;
  email?: string;
  exp: number;
  role?: string;
  /** How this session was signed in (Supabase's `amr` claim): "password", "otp" (a code), "oauth"... with the time of each. It survives a token refresh. */
  amr?: { method: string; timestamp: number }[];
}

const b64 = (s: string) => Buffer.from(s, 'base64url');

type Jwk = crypto.JsonWebKey & { kid?: string; alg?: string };
let jwks: { keys: Map<string, crypto.KeyObject>; fetchedAt: number } | null = null;

async function keyFor(kid: string | undefined): Promise<crypto.KeyObject | null> {
  const stale = !jwks || Date.now() - jwks.fetchedAt > 10 * 60_000 || (kid && !jwks.keys.has(kid));
  if (stale && (!jwks || Date.now() - jwks.fetchedAt > 15_000)) {
    const res = await fetch(`${config.supabase.url}/auth/v1/.well-known/jwks.json`, { headers: { apikey: config.supabase.anonKey } });
    if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
    const body = (await res.json()) as { keys: Jwk[] };
    jwks = { fetchedAt: Date.now(), keys: new Map(body.keys.map((k) => [k.kid ?? '', crypto.createPublicKey({ key: k, format: 'jwk' })])) };
  }
  return jwks?.keys.get(kid ?? '') ?? (jwks && jwks.keys.size === 1 && !kid ? [...jwks.keys.values()][0] : null);
}

/**
 * Verifies a Supabase access token (signature + expiry + audience). Never trusts an unsigned token.
 * HS256 with the project's JWT secret, or ES256/RS256 against the project's published signing keys.
 * Returns null for anything that is not a currently valid session token.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedToken | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(b64(parts[0]).toString()) as { alg?: string; kid?: string };
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = b64(parts[2]);

    let ok = false;
    if (header.alg === 'HS256') {
      if (!config.supabase.jwtSecret) return null;
      const expected = crypto.createHmac('sha256', config.supabase.jwtSecret).update(signed).digest();
      ok = expected.length === sig.length && crypto.timingSafeEqual(expected, sig);
    } else if (header.alg === 'ES256' || header.alg === 'RS256') {
      const key = await keyFor(header.kid);
      if (!key) return null;
      ok = crypto.verify('sha256', signed, header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, sig);
    }
    if (!ok) return null;

    const p = JSON.parse(b64(parts[1]).toString()) as Record<string, unknown>;
    if (typeof p.exp !== 'number' || p.exp * 1000 <= Date.now()) return null;
    if (p.aud !== 'authenticated' || p.role !== 'authenticated' || typeof p.sub !== 'string') return null;
    const amr = Array.isArray(p.amr)
      ? (p.amr as unknown[]).flatMap((a) => (a && typeof a === 'object' && typeof (a as { method?: unknown }).method === 'string' && typeof (a as { timestamp?: unknown }).timestamp === 'number' ? [{ method: (a as { method: string }).method, timestamp: (a as { timestamp: number }).timestamp }] : []))
      : [];
    return { sub: p.sub, exp: p.exp, role: p.role as string, phone: typeof p.phone === 'string' ? p.phone : undefined, email: typeof p.email === 'string' ? p.email : undefined, amr };
  } catch {
    return null;
  }
}
