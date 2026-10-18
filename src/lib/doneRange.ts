import { addDays, istDay } from './format';

/** Which finished washes the specialist's Completed tab shows: the day (Pune) a wash was finished. */
export type DoneRange = 'today' | 'yesterday' | 'week' | 'all';
export const DONE_LABEL: Record<DoneRange, string> = { today: 'Today', yesterday: 'Yesterday', week: 'Last 7 days', all: 'All' };
export const DONE_WORDS: Record<DoneRange, string> = { today: 'today', yesterday: 'yesterday', week: 'in the last 7 days', all: 'yet' };

/** The day (Pune) a wash was finished; a wash with no finish time is counted on its scheduled day. */
export const finishedOn = (w: { completed_at: string | null; scheduled_date: string }) => (w.completed_at ? istDay(w.completed_at) : w.scheduled_date);

export const inRange = (w: { completed_at: string | null; scheduled_date: string }, r: DoneRange, today: string) => {
  const d = finishedOn(w);
  return r === 'all' ? true : r === 'today' ? d === today : r === 'yesterday' ? d === addDays(today, -1) : d >= addDays(today, -6) && d <= today;
};
