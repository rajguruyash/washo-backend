import type { OfferKind } from './types';

/** Where an offer leads: a discount to the membership builder, a complimentary wash to the free-wash page while a campaign runs (otherwise to booking). */
export const offerLink = (kind: OfferKind, campaignOn: boolean) => (kind === 'discount' ? '/app/membership/new' : campaignOn ? '/navratri' : '/app/book');
