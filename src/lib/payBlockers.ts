import type { PublicSettings } from './types';

/**
 * Something that has to be put right before the slider can pay. The slider is never dead: when the customer slides it and something is missing, the handle
 * turns red with `label`, and the page scrolls to `target` (the id of the place the missing information goes) and flashes it.
 */
export interface Blocker {
  /** Short: it is written inside the slider (28 characters or fewer). */
  label: string;
  /** The id of the element to scroll to. */
  target?: string;
}

/** Maintenance mode: new bookings are paused. The notice at the top of the page (id "maintenance-note") says why. */
export const pausedBlocker = (s?: PublicSettings | null): Blocker[] => (s?.maintenance_mode ? [{ label: 'Booking is paused for now', target: 'maintenance-note' }] : []);

/** Someone who signed in with their email has to give a mobile number before they pay (a specialist rings before every wash). */
export const phoneBlocker = (needsPhone: boolean, what = 'pay'): Blocker[] => (needsPhone ? [{ label: `Add your number to ${what}`, target: 'pay-phone' }] : []);

/** The "Where" part of a booking: nothing to come to without an address. */
export const addressBlocker = (hasAddress: boolean): Blocker[] => (hasAddress ? [] : [{ label: 'Add an address first', target: 'pay-address' }]);
