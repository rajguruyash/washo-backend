import { defineConfig } from 'vitest/config'

// API tests run the website server against a fake Supabase (Auth, edge functions, Storage) that is backed by a real,
// LOCAL copy of the WASHO database with every migration applied. Run via supabase/tests/run.sh api.
export default defineConfig({
  test: {
    include: ['backend/tests/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { NODE_ENV: 'test', RESEND_API_KEY: '' },
  },
})
