import { Router } from 'express';
import { asyncHandler } from '../middleware/http';
import { processWebhook } from '../razorpay';

export const webhookRouter = Router();

// Razorpay calls this by itself when a payment is captured. No cookie, no login: the signature over the exact body is the proof.
// Anything Razorpay should retry (we could not reach Razorpay or the database) answers 5xx; anything it should stop sending answers 2xx.
webhookRouter.post(
  '/razorpay/webhook',
  asyncHandler(async (req, res) => {
    const outcome = await processWebhook((req as unknown as { rawBody?: Buffer }).rawBody, req.get('x-razorpay-signature') ?? undefined);
    res.json({ success: true, ...outcome });
  })
);
