import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Gift, Percent } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/cn';
import { offerLink } from '../lib/offers';
import { useCampaign, useOffers } from '../lib/queries';
import type { LiveOffer } from '../lib/types';
import { CampaignGlare } from './CampaignGlare';

/** One offer as a slim strip. Also used by the Admin page's preview, so what an admin sees is what the site shows. */
export function OfferStrip({ offer, to, className }: { offer: Pick<LiveOffer, 'kind' | 'headline' | 'details' | 'code'>; to?: string; className?: string }) {
  const Icon = offer.kind === 'discount' ? Percent : Gift;
  const body = (
    <>
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="truncate">
        {offer.headline}
        {offer.details ? <span className="hidden font-medium text-mist sm:inline">{` · ${offer.details}`}</span> : null}
      </span>
      {offer.code ? <span className="shrink-0 rounded-md border border-dashed border-washo-300/60 bg-ink-950/40 px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-wider text-white">{offer.code}</span> : null}
      {to ? <ArrowRight className="h-3.5 w-3.5 shrink-0 text-white transition-transform group-hover:translate-x-0.5" aria-hidden /> : null}
    </>
  );
  const style = cn('group flex h-9 items-center justify-center gap-2 border-t border-washo-400/25 bg-gradient-to-r from-washo-600/15 via-washo-500/35 to-washo-600/15 px-4 text-[13px] font-semibold text-washo-200', to && 'transition-colors hover:via-washo-500/50', className);
  return to ? <Link to={to} className={style}>{body}</Link> : <div className={style}>{body}</div>;
}

/**
 * The offer an admin switched on in Admin -> Campaigns, in a slim strip under the site header (the mobile app shows the same offer at the top of Home). With more than one
 * on, they take turns. Nothing shows when none is on, or when it cannot be fetched.
 */
export function OfferBanner() {
  const { data } = useOffers();
  const camp = useCampaign().data?.campaign;
  const campaignOn = Boolean(camp && camp.state !== 'full');
  const offers = data ?? [];
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (offers.length < 2) return;
    const t = window.setInterval(() => setTurn((n) => n + 1), 5000);
    return () => window.clearInterval(t);
  }, [offers.length]);
  if (!offers.length) return null;
  const o = offers[turn % offers.length];
  return (
    <CampaignGlare radius="0" glintEvery={11000}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={o.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }} role="status">
          <OfferStrip offer={o} to={offerLink(o.kind, campaignOn)} />
        </motion.div>
      </AnimatePresence>
    </CampaignGlare>
  );
}
