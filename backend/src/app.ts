import express from 'express';
import fs from 'fs';
import helmet from 'helmet';
import path from 'path';
import { config } from './config';
import { HttpError } from './errors';
import { apiLimiter, errorHandler, sameOriginWrites } from './middleware/http';
import { accountRouter } from './routes/account';
import { adminRouter } from './routes/admin';
import { adminCampaignsRouter } from './routes/adminCampaigns';
import { adminManageRouter } from './routes/adminManage';
import { authRouter } from './routes/auth';
import { bookingsRouter } from './routes/bookings';
import { campaignRouter } from './routes/campaign';
import { catalogRouter } from './routes/catalog';
import { membershipsRouter } from './routes/memberships';
import { webhookRouter } from './routes/webhook';
import { workerRouter } from './routes/worker';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind Render/nginx the client IP is in X-Forwarded-For; needed for rate limits.
  if (config.isProd) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'script-src': ["'self'", 'https://checkout.razorpay.com'],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
          // wash photos arrive as signed Supabase Storage URLs
          'img-src': ["'self'", 'data:', 'blob:', 'https:'],
          'connect-src': ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com', 'https://checkout.razorpay.com'],
          'frame-src': ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
          'form-action': ["'self'", 'https://api.razorpay.com'],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    })
  );

  // The Razorpay webhook is signed over the exact bytes it sent, so keep them for that one route.
  app.use(
    express.json({
      limit: '100kb',
      verify: (req, _res, buf) => {
        if ((req as express.Request).originalUrl.startsWith('/api/razorpay/webhook')) (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use('/api', apiLimiter, sameOriginWrites);
  app.get('/api/health', (_req, res) => res.json({ success: true }));
  app.use('/api', catalogRouter, authRouter, accountRouter, membershipsRouter, bookingsRouter, campaignRouter, workerRouter, adminRouter, adminManageRouter, adminCampaignsRouter, webhookRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Not found')));

  // Serve the built React app (same origin as the API, which keeps cookie auth simple).
  const distPath = process.env.STATIC_DIR || path.join(__dirname, '..', '..', 'dist');
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.send('WASHO API is running. Build the frontend (npm run build) or use the Vite dev server.'));
  }

  app.use(errorHandler);
  return app;
}
