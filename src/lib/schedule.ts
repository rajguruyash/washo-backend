import type { ExactDate, WashKind } from './types';

export interface Need { body: number; deep: number }

/**
 * What is wrong with a set of exact dates, in words; null when it is fine. The same rules the database enforces before it takes any money:
 * the right number of each kind of wash, one a day (back to back on following days is fine), inside the term and not before the earliest start
 * (not today or tomorrow). (A rush day is allowed: it is only shown red.)
 */
export function exactDatesProblem(o: { value: ExactDate[]; need: Need; minDate: string; end: string }): string | null {
  const body = o.value.filter((v) => v.kind === 'body').length;
  const deep = o.value.length - body;
  if (body < o.need.body || deep < o.need.deep) {
    const b = o.need.body - body, d = o.need.deep - deep;
    return `Choose ${[b > 0 && `${b} more Body wash${b > 1 ? 'es' : ''}`, d > 0 && `${d} more Deep clean${d > 1 ? 's' : ''}`].filter(Boolean).join(' and ')}.`;
  }
  if (body > o.need.body || deep > o.need.deep) return `You have chosen too many: your plan has ${o.need.body} Body washes and ${o.need.deep} Deep cleans.`;
  const days = new Set(o.value.map((v) => v.date));
  if (days.size < o.value.length) return 'Two washes are on the same day. A vehicle is washed once a day.';
  if (o.value.some((v) => v.date < o.minDate || v.date > o.end)) return 'Every wash must be inside your membership, and not today or tomorrow.';
  return null;
}

export type { WashKind };
