import { describe, expect, it } from 'vitest';
import { finishedOn, inRange } from './doneRange';

const w = (completed_at: string | null, scheduled_date = '2026-10-01') => ({ completed_at, scheduled_date });
const TODAY = '2026-10-18';

describe('Completed tab: finished today, yesterday, in the last week', () => {
  it('counts the day in Pune, not in UTC (a wash finished at 11:30 pm on the 17th is the 17th)', () => {
    expect(finishedOn(w('2026-10-17T18:00:00Z'))).toBe('2026-10-17');   // 11:30 pm IST on the 17th
    expect(finishedOn(w('2026-10-17T19:00:00Z'))).toBe('2026-10-18');   // 12:30 am IST on the 18th
  });

  it('today, yesterday, last 7 days and all', () => {
    const today = w('2026-10-18T05:00:00Z'), yesterday = w('2026-10-17T05:00:00Z'), sixAgo = w('2026-10-12T05:00:00Z'), sevenAgo = w('2026-10-11T05:00:00Z');
    expect([today, yesterday, sixAgo, sevenAgo].map((x) => inRange(x, 'today', TODAY))).toEqual([true, false, false, false]);
    expect([today, yesterday, sixAgo, sevenAgo].map((x) => inRange(x, 'yesterday', TODAY))).toEqual([false, true, false, false]);
    expect([today, yesterday, sixAgo, sevenAgo].map((x) => inRange(x, 'week', TODAY))).toEqual([true, true, true, false]);
    expect([today, yesterday, sixAgo, sevenAgo].map((x) => inRange(x, 'all', TODAY))).toEqual([true, true, true, true]);
  });

  it('a wash with no finish time is counted on its scheduled day', () => {
    expect(inRange(w(null, TODAY), 'today', TODAY)).toBe(true);
    expect(inRange(w(null, '2026-10-01'), 'today', TODAY)).toBe(false);
  });
});
