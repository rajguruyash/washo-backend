import { z } from 'zod';

/** Accepts 9876543210, 09876543210, 919876543210, +91 98765 43210 → "+919876543210". */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, '').replace(/^\+/, '');
  const m = digits.match(/^(?:91|0)?([6-9]\d{9})$/);
  return m ? `+91${m[1]}` : null;
}

export const phoneSchema = z.string().transform((v, ctx) => {
  const phone = normalizePhone(v);
  if (!phone) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit Indian mobile number.' });
    return z.NEVER;
  }
  return phone;
});
