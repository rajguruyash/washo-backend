import { percent } from './format';
import type { CampaignPackOffer, CampaignStatus } from './types';

/** "11 Oct" for a timestamp, in Pune time. */
export const shortDayIST = (iso: string): string =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** "Sat, 11 Oct" for a plain YYYY-MM-DD date (never "Today" or "Tomorrow": these dates are printed in offers and settings). */
export const dayOf = (date: string): string =>
  new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

/** "10 Sept, 10:00 am" for a timestamp, in Pune time. */
export const timeIST = (iso: string): string =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).format(new Date(iso));

type Window = { claim_opens_on: string; claim_closes_on: string; claim_opens_at?: string | null; claim_closes_at?: string | null };
/** When claims open, in words: the exact time when the campaign has one, otherwise the day. */
export const opensLabel = (c: Window): string => (c.claim_opens_at ? timeIST(c.claim_opens_at) : dayOf(c.claim_opens_on));
/** When claims close, in words: the exact time when the campaign has one, otherwise the day (the whole day counts). */
export const closesLabel = (c: Window): string => (c.claim_closes_at ? timeIST(c.claim_closes_at) : dayOf(c.claim_closes_on));
/** The instants a campaign opens and closes. A campaign with no times opens at the start of its first day and closes at the end of its last (Pune time). */
export const claimWindow = (c: Window): { opens: number; closes: number } => ({
  opens: Date.parse(c.claim_opens_at ?? `${c.claim_opens_on}T00:00:00+05:30`),
  closes: Date.parse(c.claim_closes_at ?? `${c.claim_closes_on}T00:00:00+05:30`) + (c.claim_closes_at ? 0 : 86_400_000),
});

/** A Pune date-and-time as a form field holds it ("2026-09-10T10:00"), from a timestamp. */
export const istInput = (iso: string): string => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
/** The timestamp (with its +05:30 offset) for what a person typed in a Pune date-and-time field. */
export const fromIstInput = (local: string): string => `${local.slice(0, 16)}:00+05:30`;

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
