import { defineConfig } from 'vitest/config'

// Database tests run against LOCAL throwaway copies of the production schema (see supabase/tests/run.sh).
// They never connect to Supabase.
export default defineConfig({
  test: {
    include: ['supabase/tests/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
