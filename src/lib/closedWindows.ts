import { addDays } from './format';
import { SLOTS } from './slots';
import type { SlotId } from './types';

/** What the booking pages are told about a membership's term: the days WASHO is closed and the time windows it has turned off on the other days (Admin -> Working Days). */
export interface TermClosures {
  /** The weekdays the customer picked (0 = Sunday). */
  weekdays: number[];
  /** First and last day of the term. */
  from: string;
  to: string;
  closed: { date: string }[];
  closedSlots: { date: string; slot: SlotId }[];
}

const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** The picked weekdays on which this window can never be used in the term: every such date is closed, or has the window turned off. (The server refuses these too.) */
export function weekdaysWithoutWindow(slot: SlotId, t: TermClosures): number[] {
  if (t.weekdays.length === 0 || t.to < t.from) return [];
  const shut = new Set([...t.closed.map((c) => c.date), ...t.closedSlots.filter((c) => c.slot === slot).map((c) => c.date)]);
  const hasOpen = new Set<number>();
  for (let d = t.from, i = 0; d <= t.to && i < 800; d = addDays(d, 1), i++) if (!shut.has(d)) hasOpen.add(weekdayOf(d));
  return t.weekdays.filter((w) => !hasOpen.has(w));
}

/** The windows that work on every picked weekday. */
export function windowsThatFit(t: TermClosures): SlotId[] {
  return SLOTS.map((s) => s.id).filter((slot) => weekdaysWithoutWindow(slot, t).length === 0);
}
