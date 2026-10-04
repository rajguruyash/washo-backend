import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // The browser always talks to /api on its own origin (cookie auth needs that), and in
  // development Vite forwards it to the Express server.
  const target = `http://localhost:${env.PORT || 5000}`
  return {
    plugins: [react()],
    // /__dev exists only in `npm run dev:stack` (simulated Razorpay checkout); in production nothing serves it.
    server: { proxy: { '/api': { target, changeOrigin: false }, '/__dev': { target, changeOrigin: false } } },
  }
})
