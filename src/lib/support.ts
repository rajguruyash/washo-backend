import type { Tone } from '../components/ui/Badge';
import type { TicketCategory, TicketStatus } from './types';

/** How a complaint's status reads to the customer, and to WASHO. */
export const CUSTOMER_STATUS_TEXT: Record<TicketStatus, string> = { open: 'We have it', in_progress: 'Being looked at', resolved: 'Sorted', closed: 'Closed' };
export const ADMIN_STATUS_LABEL: Record<TicketStatus, string> = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
export const STATUS_TONE: Record<TicketStatus, Tone> = { open: 'amber', in_progress: 'blue', resolved: 'green', closed: 'slate' };
export const CATEGORY_LABEL: Record<TicketCategory, string> = { payment: 'A payment', booking: 'A booking', specialist: 'A specialist', refund: 'A refund', membership: 'A membership', other: 'Something else' };
