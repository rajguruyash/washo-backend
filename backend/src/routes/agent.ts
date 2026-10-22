import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import * as agent from '../agent/run';
import { agentEnabled } from '../agent/llm';
import { AgentError } from '../agent/types';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';

/**
 * Woshi, the booking assistant. Only signed-in customers; the customer is whoever the session says, never anything in the request. The screen sends only the customer's new words (or
 * "I saved it" / "I paid" after a card): the history, the tool answers and the cards are all kept and built here.
 */
export const agentRouter = Router();
agentRouter.use('/agent', requireSession, requireRole('customer'));

const actor = (req: Request): agent.Actor => ({ sub: req.session!.claims.sub, profile: req.session!.profile, db: req.db });
const off = () => new HttpError(503, 'agent_unavailable', 'Woshi is not available right now. You can still book from the Book and Plans screens.');

/** An AgentError is a plain, safe sentence for the customer (a limit, a model that could not be reached): it becomes the ordinary error answer. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AgentError) throw new HttpError(err.status, err.code, err.message, err.notice ? { notice: err.notice } : undefined);
    throw err;
  }
}

agentRouter.get(
  '/agent/status',
  asyncHandler(async (req, res) => {
    // not switched on (no key, or turned off): the screens show no assistant at all
    if (!agentEnabled()) return res.json({ success: true, enabled: false });
    res.json({ success: true, enabled: true, ...agent.status(req.session!.profile) });
  })
);

agentRouter.get(
  '/agent/history',
  asyncHandler(async (req, res) => {
    if (!agentEnabled()) throw off();
    res.json({ success: true, ...agent.history(actor(req)) });
  })
);

agentRouter.post(
  '/agent/chat',
  asyncHandler(async (req, res) => {
    if (!agentEnabled()) throw off();
    const { message } = parse(z.object({ message: z.string().max(4000, 'That message is too long.') }), req.body);
    res.json({ success: true, ...(await run(() => agent.chat(actor(req), message))) });
  })
);

const uuid = z.string().uuid();
const eventBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('vehicle_saved'), vehicle_id: uuid, card_id: uuid.optional() }),
  z.object({ type: z.literal('address_saved'), address_id: uuid, card_id: uuid.optional() }),
  z.object({ type: z.literal('paid'), kind: z.enum(['single', 'membership']), id: uuid, card_id: uuid.optional() }),
  z.object({ type: z.literal('payment_cancelled') }),
]);

agentRouter.post(
  '/agent/event',
  asyncHandler(async (req, res) => {
    if (!agentEnabled()) throw off();
    const ev = parse(eventBody, req.body);
    res.json({ success: true, ...(await run(() => agent.event(actor(req), ev))) });
  })
);

// A coupon typed on a pay card (or taken off it, code null): the card comes back priced again by the database, or the reason in plain words.
agentRouter.post(
  '/agent/coupon',
  asyncHandler(async (req, res) => {
    if (!agentEnabled()) throw off();
    const b = parse(z.object({ card_id: uuid, code: z.string().trim().max(30).nullable() }), req.body);
    res.json({ success: true, ...(await run(() => agent.couponOnCard(actor(req), b.card_id, b.code || null))) });
  })
);

agentRouter.post(
  '/agent/new',
  asyncHandler(async (req, res) => {
    agent.newChat(actor(req));
    res.json({ success: true });
  })
);
