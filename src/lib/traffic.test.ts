import { describe, expect, it } from 'vitest';
import { ago, barHeight, teamLine } from './traffic';

describe('the team line under a customers\' number', () => {
  it('names specialists and admins that are counted, and is empty when there are none', () => {
    expect(teamLine({ customers: 5, workers: 0, admins: 0 })).toBe('');
    expect(teamLine({ customers: 5, workers: 1, admins: 0 })).toBe('+ 1 specialist');
    expect(teamLine({ customers: 0, workers: 2, admins: 1 })).toBe('+ 2 specialists · 1 admin');
    expect(teamLine({ customers: 0, workers: 0, admins: 3 })).toBe('+ 3 admins');
  });
});

describe('how long ago', () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  it('says just now, minutes, hours', () => {
    const now = Date.now();
    expect(ago(at(10_000), now)).toBe('just now');
    expect(ago(at(4 * 60_000), now)).toBe('4 min ago');
    expect(ago(at(59 * 60_000), now)).toBe('59 min ago');
    expect(ago(at(3 * 3_600_000), now)).toBe('3 h ago');
  });
  it('is never negative when the clocks differ a little', () => {
    expect(ago(new Date(Date.now() + 5000).toISOString(), Date.now())).toBe('just now');
  });
  it('gives a date after a day', () => {
    expect(ago('2026-01-10T06:00:00.000Z', Date.parse('2026-02-20T00:00:00Z'))).toBe('10 Jan');
  });
});

describe('bars', () => {
  it('an empty day is a sliver, a small number is still visible, the biggest is full height', () => {
    expect(barHeight(0, 10)).toBe(2);
    expect(barHeight(1, 100)).toBe(6);
    expect(barHeight(10, 10)).toBe(100);
    expect(barHeight(0, 0)).toBe(2);
  });
});
