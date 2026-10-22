import { describe, expect, it } from 'vitest';
import { queueTab } from './workerQueue';

describe('the specialist queue tabs', () => {
  it('keeps what is due today in Today and what is ahead in Upcoming', () => {
    expect(queueTab({ bucket: 'today', is_overdue: false })).toBe('today');
    expect(queueTab({ bucket: 'upcoming', is_overdue: false })).toBe('upcoming');
  });

  it('moves a wash from an earlier day that was never started to Overdue', () => {
    expect(queueTab({ bucket: 'today', is_overdue: true })).toBe('overdue');
  });

  it('leaves every other bucket alone', () => {
    for (const bucket of ['in_progress', 'completed', 'changed'] as const) expect(queueTab({ bucket, is_overdue: false })).toBe(bucket);
  });
});
