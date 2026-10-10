import { Pool, PoolClient, types } from 'pg';
import { config } from './config';

// Calendar dates stay plain 'YYYY-MM-DD' strings (no JS Date / timezone drift), and bigint counters become numbers.
types.setTypeParser(1082, (value: string) => value);
types.setTypeParser(20, (value: string) => Number(value));

function buildPool(): Pool {
  const { url, ssl } = config.database;
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const isLocal = ['localhost', '127.0.0.1', '::1', ''].includes(host);
  const mode = ssl || (isLocal ? 'off' : 'require');
  return new Pool({
    connectionString: url,
    ssl: mode === 'off' ? false : { rejectUnauthorized: mode === 'verify' },
    max: 10,
    // Opening a connection to Supabase costs several network round trips (TCP, TLS, auth). Keep them warm between requests.
    idleTimeoutMillis: 5 * 60_000,
    keepAlive: true,
  });
}

export const pool = buildPool();
// An idle pooled connection can be closed by the server; that must never crash the process.
pool.on('error', (err) => console.warn('Idle database connection dropped:', err.message));

/** What Postgres needs to know about the caller for auth.uid() and row-level security. */
export interface Claims {
  sub: string;
  phone?: string;
  email?: string;
  /** How the session was signed in (the token's own `amr` claim), so a sensitive step can ask for a recent code. */
  amr?: { method: string; timestamp: number }[];
}

/**
 * Every network round trip to Supabase costs real time from Render. BEGIN and the per-request settings go out as ONE
 * message (simple protocol, values escaped by the driver), so a request costs: 1 (setup) + its queries + 1 (COMMIT).
 */
async function inTransaction<T>(settings: ((c: PoolClient) => string) | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const setup = settings ? settings(client) : '';
    await client.query(`BEGIN; SELECT set_config('statement_timeout', '15000', true)${setup ? `, ${setup}` : ''}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` AS the signed-in person, exactly the way PostgREST does for the mobile app:
 * their JWT claims are set for the transaction and the role drops to `authenticated`. Row-level security,
 * auth.uid() and every function's own checks therefore apply to them. This server cannot do more than they can.
 */
export function withUser<T>(claims: Claims, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(
    (c) => `set_config('request.jwt.claims', ${c.escapeLiteral(JSON.stringify({ ...claims, role: 'authenticated' }))}, true), set_config('role', 'authenticated', true)`,
    fn
  );
}

/** Runs `fn` as an anonymous visitor (public catalogue only). */
export function withAnon<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction((c) => `set_config('request.jwt.claims', ${c.escapeLiteral(JSON.stringify({ role: 'anon' }))}, true), set_config('role', 'anon', true)`, fn);
}

/** Runs `fn` as `washo_api` itself (service wrappers only: housekeeping). */
export function withApiRole<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(null, fn);
}
