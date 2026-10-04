import type { Tone } from '../components/ui/Badge';
import type { BookingStatus } from './types';

/** How a wash's status reads to a CUSTOMER. Worker steps are shown as "specialist assigned"; a missed call is not alarming. */
export const customerStatus: Record<BookingStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Awaiting payment', tone: 'amber' },
  confirmed: { label: 'Scheduled', tone: 'blue' },
  worker_assigned: { label: 'Specialist assigned', tone: 'blue' },
  worker_called: { label: 'Specialist assigned', tone: 'blue' },
  call_not_picked_up: { label: 'Scheduled', tone: 'blue' },
  in_progress: { label: 'In progress', tone: 'yellow' },
  completed: { label: 'Completed', tone: 'green' },
  rescheduled: { label: 'Rescheduled', tone: 'slate' },
  cancelled: { label: 'Cancelled', tone: 'red' },
  refund_requested: { label: 'Refund requested', tone: 'amber' },
  refunded: { label: 'Refunded', tone: 'slate' },
  no_show: { label: 'Missed', tone: 'red' },
};

/** Staff see the real state of the wash. */
export const staffStatus: Record<BookingStatus, { label: string; tone: Tone }> = {
  ...customerStatus,
  confirmed: { label: 'Unassigned', tone: 'amber' },
  worker_assigned: { label: 'Assigned', tone: 'blue' },
  worker_called: { label: 'Customer called', tone: 'blue' },
  call_not_picked_up: { label: 'Call not picked up', tone: 'amber' },
};

export const LIVE_STATUSES: BookingStatus[] = ['pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress'];
export const isLive = (s: BookingStatus) => LIVE_STATUSES.includes(s);
