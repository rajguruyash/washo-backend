import { defineConfig } from 'vitest/config'

// Pure unit tests (no database, no network): formatting helpers and the Razorpay signature helpers.
// Database tests:  npm run db:test / db:test:full     API tests: npm run test:api
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'supabase/functions/**/*.test.ts'],
    environment: 'node',
  },
})
