import { z } from 'zod';
import { HttpError } from './errors';

/**
 * A membership chosen as washes in a MONTH: how many Body washes and Deep cleans (4 to 28 in all, any mix) and the weekdays the customer likes (Sunday = 0).
 * The database checks the numbers again and says what is wrong in plain words; this only keeps nonsense out of the call.
 */
export const monthlyPlanSchema = z.object({
  body: z.number().int().min(0).max(28),
  deep: z.number().int().min(0).max(28),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
});
export type MonthlyPlan = z.infer<typeof monthlyPlanSchema>;

/** The database does not have monthly plans yet (migration 28 is not applied): say so instead of a stack trace. */
export const monthlyNotInstalled = (err: unknown): HttpError | null => {
  const code = (err as { code?: string } | null)?.code;
  return code === '42883' ? new HttpError(503, 'not_ready', 'Monthly plans are not switched on yet. Please try again shortly.') : null;
};
