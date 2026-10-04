import { createApp } from './app';
import { config } from './config';
import { pool, withApiRole } from './db';

async function main() {
  if (!config.supabase.serviceRoleKey) {
    console.warn('⚠️  SUPABASE_SERVICE_ROLE_KEY is not set: wash photos cannot be uploaded or viewed.');
  }
  if (config.isProd && !config.supabase.jwtSecret) {
    console.log('SUPABASE_JWT_SECRET not set: verifying sessions against the project\'s published signing keys (JWKS).');
  }

  const app = createApp();
  const server = app.listen(config.port, () => console.log(`WASHO server running on port ${config.port}`));

  // Quotes nobody accepted in time are marked expired (customers already see them as expired; this just tidies the records).
  const sweep = () => withApiRole((c) => c.query('SELECT app_private.expire_membership_quotes()')).catch((e) => console.error('Quote sweep failed:', e.message));
  const timer = setInterval(sweep, 60 * 60_000);
  timer.unref();
  void sweep();

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => pool.end().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
