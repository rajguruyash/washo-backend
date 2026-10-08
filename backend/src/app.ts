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
import { capacityRouter } from './routes/capacity';
import { forgetPublic } from './publicCache';
import { catalogRouter } from './routes/catalog';
import { geoRouter } from './routes/geo';
import { membershipsRouter } from './routes/memberships';
import { remindersRouter } from './routes/reminders';
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
          // Over plain http (a local copy of the built site) Safari would turn every asset request into https and fail; production is https already.
          ...(config.isProd ? {} : { 'upgrade-insecure-requests': null }),
          'script-src': ["'self'", 'https://checkout.razorpay.com'],
          'style-src': ["'self'", "'unsafe-inline'"],
          'font-src': ["'self'", 'data:'], // fonts are self-hosted
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
  // Anything an admin changes (prices, services, campaigns, limits) must show on the public pages at once: empty the few seconds of memory they use.
  app.use('/api/admin', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') res.on('finish', forgetPublic);
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ success: true }));
  app.use('/api', catalogRouter, authRouter, accountRouter, membershipsRouter, bookingsRouter, campaignRouter, capacityRouter, geoRouter, workerRouter, adminRouter, adminManageRouter, adminCampaignsRouter, remindersRouter, webhookRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Not found')));

  // Serve the built React app (same origin as the API, which keeps cookie auth simple).
  const distPath = process.env.STATIC_DIR || path.join(__dirname, '..', '..', 'dist');
  if (fs.existsSync(distPath)) {
    // Everything under /assets has its content in its file name (a new build is a new name), so it can be kept for a year and never re-checked:
    // a returning visitor loads the site from their own device. The few plain files (icons) are kept a day. The page itself is always re-checked,
    // so a new build is picked up at once.
    app.use(
      express.static(distPath, {
        index: false,
        maxAge: '1d',
        setHeaders: (res, file) => {
          if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => res.send('WASHO API is running. Build the frontend (npm run build) or use the Vite dev server.'));
  }

  app.use(errorHandler);
  return app;
}
