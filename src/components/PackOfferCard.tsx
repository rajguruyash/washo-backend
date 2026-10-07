import { Sparkles } from 'lucide-react';
import { shortDayIST } from '../lib/campaign';
import { percent } from '../lib/format';
import type { CampaignOffer } from '../lib/types';
import { CampaignGlare } from './CampaignGlare';
import { ButtonLink } from './ui/Button';

/** After the free wash: the welcome offer on a membership. The price at checkout already includes it. */
export function PackOfferCard({ offer, className }: { offer: CampaignOffer; className?: string }) {
  return (
    <CampaignGlare className={className}>
    <div className="glass border-offer/30 p-5">
      <div className="flex items-start gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-offer/15 text-offer"><Sparkles className="h-6 w-6" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <p className="font-bold">Your welcome offer on a membership</p>
          <p className="mt-1 text-sm text-fog">
            Start one by {shortDayIST(offer.expires_at)} and save {percent(offer.bp_1)} on 1 wash per week, {percent(offer.bp_2)} on 2, or {percent(offer.bp_3plus)} on 3 or more. It is applied for you at checkout.
          </p>
        </div>
      </div>
      <ButtonLink to="/app/membership/new" className="mt-4" full>Build my membership</ButtonLink>
    </div>
    </CampaignGlare>
  );
}
