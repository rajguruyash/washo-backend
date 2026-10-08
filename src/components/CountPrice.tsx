import { useReducedMotion } from 'framer-motion';
import { rupees } from '../lib/format';
import { useSiteReady } from '../lib/siteReady';
import CountUp from './reactbits/CountUp';

/**
 * Where each service's price counts down from, in rupees. This is an animation only: the number always lands on the real
 * price from the rate card, and nothing else (no "was" price, no strike-through) is shown. What a customer is charged is
 * decided by the database, never by anything on this page.
 */
export const COUNT_FROM_RUPEES: Record<string, number> = {
  'bike-body-wash': 150,
  'car-body-wash': 200,
  'car-deep-cleaning': 350,
  'suv-deep-cleaning': 500,
};

/** The anchored total for an estimate's lines (each wash at its anchor price), or null if a line has no anchor. */
export function anchorTotalCents(lines: { code?: string; quantity: number }[]): number | null {
  let total = 0;
  for (const l of lines) {
    const from = l.code ? COUNT_FROM_RUPEES[l.code] : undefined;
    if (!from) return null;
    total += from * 100 * l.quantity;
  }
  return total;
}

/**
 * ₹ price that counts down from a higher number to the real one (React Bits CountUp). Pass `code` for a per-wash service
 * price, or `fromCents` for a total. It starts once the opening loading screen has gone and the price is on screen, and takes under a second. Shows the plain price when the animation does not apply (reduced motion, paise, or no
 * higher starting number), and when `animate` is false.
 */
export function CountPrice({ cents, code, fromCents, animate = true, className, duration = 0.8 }: { cents: number; code?: string; fromCents?: number | null; animate?: boolean; className?: string; duration?: number }) {
  const reduce = useReducedMotion();
  const siteReady = useSiteReady(); // not before the opening loading screen has gone: it would count unseen
  const from = fromCents != null ? fromCents / 100 : code ? COUNT_FROM_RUPEES[code] : undefined;
  const to = cents / 100;
  if (reduce || !animate || from == null || !Number.isInteger(to) || !Number.isInteger(from) || from <= to) return <span className={className}>{rupees(cents)}</span>;
  return (
    <span className={className}>
      <span aria-hidden>₹<CountUp from={from} to={to} duration={duration} separator="," startWhen={siteReady} /></span>
      <span className="sr-only">{rupees(cents)}</span>
    </span>
  );
}
