import type { SignInMethod, TrafficCounts, TrafficRole, TrafficSource } from './types';

/** Words for the Traffic screens. */
export const METHOD_LABEL: Record<SignInMethod, string> = {
  phone: 'Mobile number and code',
  email: 'Email and password',
  signup: 'New account (email)',
  google: 'Google',
  admin_email: 'Email, password and code',
};
export const ROLE_WORD: Record<TrafficRole, string> = { customer: 'Customer', worker: 'Specialist', admin: 'Admin' };
export const SOURCE_WORD: Record<TrafficSource, string> = { website: 'Website', app: 'App' };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The team members among the people counted, for under a customers' number: "+ 2 specialists · 1 admin", or nothing when there are none. */
export function teamLine(c: TrafficCounts): string {
  const parts = [c.workers > 0 && plural(c.workers, 'specialist'), c.admins > 0 && plural(c.admins, 'admin')].filter(Boolean);
  return parts.length ? `+ ${parts.join(' · ')}` : '';
}

/** "just now", "4 min ago", "3 h ago", or the day. `now` is passed in so a screen can keep it fresh. */
export function ago(iso: string, now: number): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
}

/** A time of day in Pune, e.g. "9:05 AM". */
export const clock = (iso: string): string => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** Height (as a percentage) of a bar: a value of zero is a sliver, so an empty day still shows. */
export const barHeight = (value: number, max: number): number => (value > 0 ? Math.max(6, (value / Math.max(1, max)) * 100) : 2);
