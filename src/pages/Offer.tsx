import { animate, useReducedMotion } from 'framer-motion';
import { ArrowRight, CalendarCheck, Check, Gift, MapPin, ShieldCheck, Smartphone, Sparkles, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CampaignGlare } from '../components/CampaignGlare';
import { ErrorState } from '../components/EmptyState';
import { Badge } from '../components/ui/Badge';
import { ButtonLink } from '../components/ui/Button';
import { Reveal } from '../components/ui/Reveal';
import { Skeleton } from '../components/ui/Skeleton';
import { audience, claimView, dayOf, offerRates } from '../lib/campaign';
import { percent, rupees } from '../lib/format';
import { useCampaign, useCatalog } from '../lib/queries';
import type { Campaign } from '../lib/types';
import { useAuth } from '../state/auth';

const CLAIM_LINK = '/login?next=%2Fapp%2Fclaim';

/** ₹150 counting down to FREE over 1.2 seconds (the price a car body wash would be, to nothing). */
function FreeCountdown({ from }: { from: number }) {
  const reduce = useReducedMotion();
  const [n, setN] = useState(reduce ? 0 : from);
  useEffect(() => {
    if (reduce) return;
    const controls = animate(from, 0, { duration: 1.2, delay: 0.5, ease: [0.22, 1, 0.36, 1], onUpdate: (v) => setN(Math.round(v)) });
    return () => controls.stop();
  }, [from, reduce]);
  const free = n <= 0;
  return (
    <p className="font-display text-7xl font-extrabold leading-none tracking-tight sm:text-8xl" aria-label="Free">
      {free ? <span className="text-offer">FREE</span> : <span className="tabular-nums" aria-hidden>₹{n}</span>}
    </p>
  );
}

function ClaimButton({ campaign, size = 'lg' }: { campaign: Campaign; size?: 'md' | 'lg' }) {
  const { user } = useAuth();
  const status = useCampaign().data;
  const view = claimView(status, user?.role);
  const me = status?.me;
  if (view === 'upcoming') return <p className="rounded-2xl border border-white/10 bg-white/[0.05] px-5 py-3.5 text-sm font-semibold text-mist">Opens {dayOf(campaign.claim_opens_on)}</p>;
  if (view === 'full') return <p className="rounded-2xl border border-white/10 bg-white/[0.05] px-5 py-3.5 text-sm font-semibold text-mist">All the free washes have been claimed. Thank you!</p>;
  if (view === 'staff') return <p className="text-sm text-fog">Sign in with a customer account to claim.</p>;
  if (view === 'booked' && me && 'booking_id' in me) return <ButtonLink to={`/app/bookings/${me.booking_id}`} size={size} iconRight={<ArrowRight className="h-5 w-5" />}>You are booked. View your free wash</ButtonLink>;
  if (view === 'completed') return <ButtonLink to="/app/membership/new" size={size} iconRight={<ArrowRight className="h-5 w-5" />}>Your free wash is done. Build a membership</ButtonLink>;
  if (view === 'forfeited') return <p className="text-sm text-fog">Your free wash was missed, so the offer has been used.</p>;
  if (view === 'ineligible') return <p className="max-w-md text-sm text-fog">This offer is for new WASHO customers. You can still <Link to="/app/membership/new" className="font-semibold text-washo-300 hover:text-white">build a membership</Link> or <Link to="/app/book" className="font-semibold text-washo-300 hover:text-white">book a wash</Link>.</p>;
  return (
    <ButtonLink to={view === 'eligible' ? '/app/claim' : CLAIM_LINK} size={size} iconRight={<ArrowRight className="h-5 w-5" />}>
      Claim my free wash
    </ButtonLink>
  );
}

const steps = [
  { icon: Smartphone, title: 'Sign in with your phone', text: 'Your mobile number and a password. That is your claim: one free wash per number.' },
  { icon: UserPlus, title: 'Add your vehicle and address', text: 'Your society and parking spot, and your bike, car or SUV. It takes a minute.' },
  { icon: Check, title: 'Slide to claim', text: 'No payment, no card. That is all you do: there is no date to pick.' },
  { icon: CalendarCheck, title: 'We choose the day and time', text: 'We place your wash on the earliest day with room, tell you straight away, and a specialist calls ahead.' },
];

export default function Offer() {
  const { data, isLoading, isError, refetch } = useCampaign();
  const { data: catalog } = useCatalog();
  const c = data?.campaign ?? null;
  const carBody = catalog?.services.find((s) => s.code === 'car-body-wash')?.unit_prices?.find((p) => p.vehicle_type === 'car')?.price_cents;

  if (isError) return <div className="mx-auto max-w-3xl px-4 pb-24 pt-32"><ErrorState onRetry={() => void refetch()} /></div>;
  if (isLoading) return <div className="mx-auto max-w-5xl space-y-4 px-4 pb-24 pt-32"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-72" /></div>;

  if (!c) {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-24 pt-36 text-center sm:px-6">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.06] text-washo-300"><Gift className="h-7 w-7" aria-hidden /></span>
        <h1 className="mt-5 text-3xl font-extrabold">No free-wash offer is running right now</h1>
        <p className="mt-3 text-fog">Watch this space. In the meantime, a membership is the best way to keep your vehicle clean.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3"><ButtonLink to="/app/membership/new" size="lg">Build a membership</ButtonLink><ButtonLink to="/services" size="lg" variant="glass">See services</ButtonLink></div>
      </div>
    );
  }

  const left = c.state === 'open' ? (c.spots_left <= 30 ? `Only ${c.spots_left} of ${c.total_cap} left` : `${c.spots_left} free washes left`) : null;
  return (
    <div className="mx-auto max-w-5xl px-4 pb-24 pt-32 sm:px-6 lg:px-8">
      <section className="grid items-center gap-10 md:grid-cols-[1.15fr_0.85fr]">
        <div>
          <Badge tone="yellow" icon={<Gift className="h-3.5 w-3.5" />}>{c.name}</Badge>
          <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] sm:text-5xl">{audience(c).headline}</h1>
          <p className="mt-4 max-w-xl text-lg text-mist">{c.description ?? `A free body wash at your parking spot for ${audience(c).long} in Kharadi, Pune. No payment, no catch.`}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            {left && <Badge tone="amber">{left}</Badge>}
            <Badge>Claim by {dayOf(c.claim_closes_on)}</Badge>
            <Badge>Wash by {dayOf(c.use_by_date)}</Badge>
          </div>
          <div className="mt-8"><ClaimButton campaign={c} /></div>
        </div>
        <Reveal>
          <CampaignGlare>
          <div className="glass-strong relative overflow-hidden p-8 text-center">
            <p className="eyebrow">Body wash for bike, car or SUV</p>
            <div className="mt-4"><FreeCountdown from={carBody ? Math.round(carBody / 100) : 150} /></div>
            <p className="mt-4 text-sm text-fog">{carBody ? `A car body wash is ${rupees(carBody)}. ` : ''}{audience(c).costs}</p>
          </div>
          </CampaignGlare>
        </Reveal>
      </section>

      <section className="mt-16" aria-labelledby="how">
        <p className="eyebrow">How to claim</p>
        <h2 id="how" className="mt-2 text-2xl font-extrabold">Quick and simple</h2>
        <ol className="mt-6 grid gap-4 sm:grid-cols-2">
          {steps.map((s, i) => (
            <Reveal key={s.title} delay={i * 0.05}>
              <li className="glass flex h-full gap-4 p-5">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-washo-500/15 text-washo-300"><s.icon className="h-5 w-5" aria-hidden /></span>
                <div><p className="font-bold">{i + 1}. {s.title}</p><p className="mt-1 text-sm text-fog">{s.text}</p></div>
              </li>
            </Reveal>
          ))}
        </ol>
      </section>

      <section className="mt-16 grid gap-5 md:grid-cols-2" aria-labelledby="rules">
        <div className="glass p-6">
          <h2 id="rules" className="flex items-center gap-2 text-lg font-bold"><ShieldCheck className="h-5 w-5 text-washo-300" aria-hidden /> The small print</h2>
          <ul className="mt-4 space-y-2.5 text-sm text-mist">
            <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> {audience(c).rule}</li>
            <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> One free wash for each phone number, vehicle and flat.</li>
            <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> You do not choose the day or time: we place your wash and tell you at once.</li>
            <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> It is a body wash: bike body wash, or car body wash for cars and SUVs.</li>
            <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> Claim from {dayOf(c.claim_opens_on)} to {dayOf(c.claim_closes_on)}. The wash itself must be on or before {dayOf(c.use_by_date)}.</li>
            <li className="flex gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> Kharadi, Pune, at your society parking spot.</li>
            <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> Cancel it and the claim comes back, while the offer is still open.</li>
          </ul>
        </div>
        <CampaignGlare><div className="glass h-full border-offer/25 p-6">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Sparkles className="h-5 w-5 text-offer" aria-hidden /> Then, a welcome offer</h2>
          <p className="mt-2 text-sm text-fog">Loved it? For {c.pack_offer.days} days after your free wash, a membership costs less:</p>
          <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
            {[
              ['4 to 7 washes a month', c.pack_offer.bp_1],
              ['8 to 11 a month', c.pack_offer.bp_2],
              ['12 or more a month', c.pack_offer.bp_3plus],
            ].map(([label, bp]) => (
              <div key={label as string} className="rounded-2xl border border-white/[0.09] bg-white/[0.04] p-3">
                <dd className="font-display text-2xl font-extrabold text-offer">{percent(bp as number)}</dd>
                <dt className="mt-0.5 text-[11px] text-fog">{label} off</dt>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-fog">{offerRates(c.pack_offer)}. Applied for you at checkout.</p>
        </div></CampaignGlare>
      </section>

      <section className="mt-16 rounded-3xl border border-white/[0.09] bg-gradient-to-br from-washo-600/25 to-transparent p-8 text-center">
        <h2 className="text-2xl font-extrabold">Ready for a clean ride?</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-fog">It takes about two minutes, and nothing is charged.</p>
        <div className="mt-6 flex justify-center"><ClaimButton campaign={c} /></div>
      </section>
    </div>
  );
}
