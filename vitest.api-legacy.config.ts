import { defineConfig } from 'vitest/config'

// Sign-in against a database shaped like PRODUCTION TODAY (the schema dump, none of the new migrations applied).
export default defineConfig({
  test: {
    include: ['backend/tests/legacy-*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { NODE_ENV: 'test', RESEND_API_KEY: '' },
  },
})
