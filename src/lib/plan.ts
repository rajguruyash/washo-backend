import { WEEKDAYS } from './format';

/** A membership is chosen as washes in a MONTH: at least 4, at most 28, any mix of Body washes and Deep cleans. (The database enforces the same.) */
export const MIN_PER_MONTH = 4;
export const MAX_PER_MONTH = 28;

/** Weekdays a month needs so that many washes fit: a weekday comes round at least 4 times a month, and a vehicle is washed once a day. */
export const daysNeeded = (washesPerMonth: number) => Math.max(1, Math.ceil(washesPerMonth / 4));

export const minWashesMessage = () => `Choose at least a total of ${MIN_PER_MONTH} washes.`;

/** The weekday names of a set of days (Mon · Thu), Monday first. */
export const dayNames = (days: number[] | null | undefined) =>
  [...(days ?? [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WEEKDAYS[d].short).join(' · ');

interface PlanLike { washes_per_month?: number | null; frequency_per_week?: number | null; duration_months: number }

/** "5 washes a month · 3 months" for a monthly plan, "2 washes per week · 3 months" for one chosen the older way. */
export function planTitle(p: PlanLike, o: { short?: boolean } = {}): string {
  const months = `${p.duration_months} ${o.short ? 'mo' : p.duration_months > 1 ? 'months' : 'month'}`;
  if (p.washes_per_month) return `${p.washes_per_month} wash${p.washes_per_month > 1 ? 'es' : ''} a month · ${months}`;
  const n = p.frequency_per_week ?? 0;
  return `${n} wash${n > 1 ? 'es' : ''} per week · ${months}`;
}

/** What is in a monthly plan, in words: 2 Body + 2 Deep a month on Mon · Thu. Null for a plan chosen the older way. */
export function monthlyDetail(p: { monthly_body?: number | null; monthly_deep?: number | null; preferred_weekdays?: number[] | null }, bike = false): string | null {
  if (p.monthly_body == null || p.monthly_deep == null) return null;
  const mix = [p.monthly_body > 0 && (bike ? `${p.monthly_body} Bike wash${p.monthly_body > 1 ? 'es' : ''}` : `${p.monthly_body} Body`), p.monthly_deep > 0 && `${p.monthly_deep} Deep`].filter(Boolean).join(' + ');
  return `${mix} a month${p.preferred_weekdays?.length ? ` on ${dayNames(p.preferred_weekdays)}` : ''}`;
}
