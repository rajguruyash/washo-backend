import { ArrowRight, Gift } from 'lucide-react';
import { Link } from 'react-router-dom';
import { shortDayIST } from '../lib/campaign';
import { useCampaign } from '../lib/queries';

/** A slim strip under the site header while a free-wash campaign is on (or about to start). Nothing shows when there is none. */
export function CampaignBanner() {
  const { data } = useCampaign();
  const c = data?.campaign;
  if (!c || c.state === 'full') return null;
  const tail = c.state === 'upcoming' ? `Starts ${shortDayIST(`${c.claim_opens_on}T00:00:00+05:30`)}` : c.spots_left <= 30 ? `Only ${c.spots_left} left` : 'Claim yours';
  return (
    <Link to="/navratri" className="group flex h-9 items-center justify-center gap-2 border-t border-offer/20 bg-gradient-to-r from-offer/10 via-offer/25 to-offer/10 px-4 text-[13px] font-semibold text-offer transition-colors hover:from-offer/20 hover:via-offer/35 hover:to-offer/20">
      <Gift className="h-4 w-4 shrink-0" aria-hidden />
      <span className="truncate">{c.name}<span className="hidden sm:inline">: a free wash for new customers</span></span>
      <span className="flex shrink-0 items-center gap-1 text-white">{tail} <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden /></span>
    </Link>
  );
}
