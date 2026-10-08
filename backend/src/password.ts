import { z } from 'zod';

/**
 * Password rules. Customers who sign up with an email choose their own, so the rule is what a person can reasonably remember: 8 or more,
 * with a letter and a number. Staff and admins (whose accounts can see other people's data, or money) need 12 or more with upper and lower
 * case and a number, and may not contain anything guessable. 72 is the most characters the password hash (bcrypt) looks at.
 */
const GUESSABLE = ['password', 'passw0rd', 'washo', 'qwerty', 'letmein', 'welcome', 'admin', '12345678', 'iloveyou', 'abc123'];

export const customerPassword = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(72, 'Use at most 72 characters.')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Use letters and at least one number.');

export const strongPassword = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(72, 'Use at most 72 characters.')
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Mix upper and lower case letters and at least one number.')
  .refine((p) => !GUESSABLE.some((w) => p.toLowerCase().includes(w)), 'That password is too easy to guess. Do not use words like "password", "admin" or "washo".');
