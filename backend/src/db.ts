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
  });
}

export const pool = buildPool();

/** What Postgres needs to know about the caller for auth.uid() and row-level security. */
export interface Claims {
  sub: string;
  phone?: string;
  email?: string;
}

async function inTransaction<T>(setup: (c: PoolClient) => Promise<void>, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    await setup(client);
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
  return inTransaction(async (c) => {
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ ...claims, role: 'authenticated' })]);
    await c.query('SET LOCAL ROLE authenticated');
  }, fn);
}

/** Runs `fn` as an anonymous visitor (public catalogue only). */
export function withAnon<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(async (c) => {
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'anon' })]);
    await c.query('SET LOCAL ROLE anon');
  }, fn);
}

/** Runs `fn` as `washo_api` itself (service wrappers only: housekeeping). */
export function withApiRole<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(async () => undefined, fn);
}
