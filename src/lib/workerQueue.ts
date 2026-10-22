import type { WorkerBucket, WorkerWash } from './types';

/**
 * The tabs of a specialist's queue: the server's buckets plus Overdue. The server keeps a wash that was due on an earlier day and never started inside "today" (and flags it
 * `is_overdue`); here it gets a tab of its own, so Today holds only what is due today and Upcoming only what is still ahead.
 */
export type QueueTab = WorkerBucket | 'overdue';

export const queueTab = (w: Pick<WorkerWash, 'bucket' | 'is_overdue'>): QueueTab => (w.bucket === 'today' && w.is_overdue ? 'overdue' : w.bucket);
