import { describe, expect, it } from 'vitest';
import { weekdaysWithoutWindow, windowsThatFit } from './closedWindows';

// 2026-10-19 is a Monday; the term runs four weeks, so every weekday has four dates.
const from = '2026-10-19', to = '2026-11-15';
const sundays = ['2026-10-25', '2026-11-01', '2026-11-08', '2026-11-15'];
const term = (over: Partial<Parameters<typeof weekdaysWithoutWindow>[1]> = {}) => ({ weekdays: [0, 3], from, to, closed: [], closedSlots: [], ...over });

describe('a time window that is off on a picked weekday', () => {
  it('is fine when nothing is turned off', () => {
    expect(weekdaysWithoutWindow('morning', term())).toEqual([]);
    expect(windowsThatFit(term())).toEqual(['morning', 'afternoon', 'night']);
  });

  it('names the weekday when the window is off on every one of its dates, and only for that window', () => {
    const t = term({ closedSlots: sundays.map((date) => ({ date, slot: 'morning' as const })) });
    expect(weekdaysWithoutWindow('morning', t)).toEqual([0]);
    expect(weekdaysWithoutWindow('afternoon', t)).toEqual([]);
    expect(windowsThatFit(t)).toEqual(['afternoon', 'night']);
  });

  it('one date still open in the term is enough', () => {
    const t = term({ closedSlots: sundays.slice(0, 3).map((date) => ({ date, slot: 'night' as const })) });
    expect(weekdaysWithoutWindow('night', t)).toEqual([]);
  });

  it('a closed day counts as off for every window', () => {
    const t = term({ closed: sundays.map((date) => ({ date })) });
    expect(weekdaysWithoutWindow('morning', t)).toEqual([0]);
    expect(windowsThatFit(t)).toEqual([]);
  });

  it('says nothing for no weekdays or an empty term', () => {
    expect(weekdaysWithoutWindow('morning', term({ weekdays: [], closedSlots: sundays.map((date) => ({ date, slot: 'morning' as const })) }))).toEqual([]);
    expect(weekdaysWithoutWindow('morning', term({ from: to, to: from }))).toEqual([]);
  });
});
