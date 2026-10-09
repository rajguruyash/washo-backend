import { percent } from './format';
import type { CampaignPackOffer, CampaignStatus } from './types';

/** "11 Oct" for a timestamp, in Pune time. */
export const shortDayIST = (iso: string): string =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** "Sat, 11 Oct" for a plain YYYY-MM-DD date (never "Today" or "Tomorrow": these dates are printed in offers and settings). */
export const dayOf = (date: string): string =>
  new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

/** "5% for 4 to 7 washes a month, 10% for 8 to 11, 15% for 12 or more" */
export const offerRates = (o: Pick<CampaignPackOffer, 'bp_1' | 'bp_2' | 'bp_3plus'>): string =>
  `${percent(o.bp_1)} for 4 to 7 washes a month, ${percent(o.bp_2)} for 8 to 11, ${percent(o.bp_3plus)} for 12 or more`;

/** The frequency discount (basis points) the offer gives for this many washes a week (a month's washes divided by 4, rounded down: 4-7 a month is 1, 8-11 is 2, 12 or more is 3 and up). */
export const offerBpFor = (o: Pick<CampaignPackOffer, 'bp_1' | 'bp_2' | 'bp_3plus'>, perWeek: number): number =>
  perWeek <= 1 ? o.bp_1 : perWeek === 2 ? o.bp_2 : o.bp_3plus;

/** Which part of the claim journey is this customer in? Drives every button and message about the campaign. */
export type ClaimView = 'none' | 'upcoming' | 'full' | 'visitor' | 'eligible' | 'booked' | 'completed' | 'forfeited' | 'ineligible' | 'staff';

export function claimView(s: CampaignStatus | undefined, signedInAs: string | null | undefined): ClaimView {
  const c = s?.campaign;
  if (!c) return 'none';
  if (signedInAs && signedInAs !== 'customer') return 'staff';
  const me = s?.me;
  if (me && (me.state === 'booked' || me.state === 'completed' || me.state === 'forfeited')) return me.state;
  if (c.state === 'upcoming') return 'upcoming';
  if (c.state === 'full') return 'full';
  if (me?.state === 'ineligible') return 'ineligible';
  if (me?.state === 'eligible') return 'eligible';
  return 'visitor';
}

/** Short wording for who the offer is for, from the campaign's setting. */
export const audience = (c: { new_customers_only: boolean }) =>
  c.new_customers_only
    ? { short: 'for new customers', long: 'new WASHO customers', headline: 'Your first wash is on us.', costs: 'For new customers it costs nothing.', rule: 'For new WASHO customers only.' }
    : { short: 'for everyone', long: 'WASHO customers', headline: 'A free wash, on us.', costs: 'It costs nothing.', rule: 'Open to everyone: new and existing customers.' };
