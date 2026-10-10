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

/**
 * A customer who signs in with a mobile number and a password has, inside Supabase Auth, an email-style login derived from the number
 * (91XXXXXXXXXX@phone.washo.invalid). Supabase's password sign-in with a PHONE needs a number confirmed by a code; this one is typed, not confirmed,
 * so the password belongs to the derived login and the number is attached to it unconfirmed (exactly what "add your number" already does).
 * ".invalid" is a reserved name that can never receive mail, so no one can use it to reset or take over an account. It is an internal key, never shown
 * and never emailed: realEmail() removes it wherever an email would be read.
 */
export const PHONE_LOGIN_DOMAIN = 'phone.washo.invalid';
export const phoneLoginEmail = (e164: string): string => `${e164.replace(/\D/g, '')}@${PHONE_LOGIN_DOMAIN}`;
export const isPhoneLoginEmail = (email: string | null | undefined): boolean => Boolean(email) && String(email).trim().toLowerCase().endsWith(`@${PHONE_LOGIN_DOMAIN}`);
/** The email if it is a real address; null for the internal login address (or nothing). */
export const realEmail = (email: string | null | undefined): string | null => (email && !isPhoneLoginEmail(email) ? email : null);
