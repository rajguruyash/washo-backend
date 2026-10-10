import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarCheck, Camera, Droplets, Gift, Leaf, MessageSquareText, ShieldCheck, Sparkles, Timer, UserCheck, Users, Wallet } from 'lucide-react';
import { AvatarFull } from '../components/brand/Avatar';
import { Badge } from '../components/ui/Badge';
import { ButtonLink } from '../components/ui/Button';
import BlurText from '../components/reactbits/BlurText';
import SplitFlapText from '../components/reactbits/SplitFlapText';
import StarBorder from '../components/reactbits/StarBorder';
import { ComboPacks } from '../components/ComboPacks';
import { RotatingLine } from '../components/RotatingLine';
import { ServiceCarousel } from '../components/ServiceCarousel';
import cardFront from '../assets/brand/washo-card.webp';
import cardBack from '../assets/brand/washo-card-back.webp';
import { Reveal } from '../components/ui/Reveal';
import { Link } from 'react-router-dom';
import { Skeleton } from '../components/ui/Skeleton';
import { audience } from '../lib/campaign';
import { useCampaign, useCatalog } from '../lib/queries';

// The lanyard is three.js, so it is its own piece of the page's code: it loads after everything else and never delays the first paint.
const Lanyard = lazy(() => import('../components/reactbits/Lanyard'));

/** True once the element is within a screen of the viewport (it stays true). The lanyard's code is only fetched then, so it costs nothing to anyone who never scrolls that far. */
function useNearViewport<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return undefined; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near] as const;
}

const steps = [
  { icon: CalendarCheck, title: 'Build your plan', text: 'Pick your vehicle, how many washes you want each month (4 or more), the days, and how long. The estimate updates as you go.' },
  { icon: Wallet, title: 'Pay securely online', text: 'Pay with Razorpay. Your washes are scheduled as soon as the payment is verified.' },
  { icon: MessageSquareText, title: 'Your specialist calls ahead', text: 'We confirm with you before every wash, so you are never caught out.' },
  { icon: Camera, title: 'We wash at your parking spot', text: 'A specialist calls ahead, washes, and you see the before and after photos.' },
];

const why = [
  { icon: UserCheck, title: 'Doorstep service', text: 'We come to your parking spot. No travel, no queues.' },
  { icon: Timer, title: 'Your days, your slot', text: 'Morning, afternoon or night, and easy rescheduling.' },
  { icon: Droplets, title: 'Low water usage', text: 'Pressure and foam wash that saves water, not shine.' },
  { icon: Leaf, title: 'Eco-friendly products', text: 'Safe for your paint, your parts and the environment.' },
  { icon: ShieldCheck, title: 'Safe for paint', text: 'Microfibre and pH-balanced foam. Scratch-free by design.' },
  { icon: Users, title: 'Verified crew', text: 'Skilled professionals who are known to your society.' },
];

export default function Landing() {
  const [lanyardRef, lanyardNear] = useNearViewport<HTMLDivElement>();
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const { data: catalog, isLoading } = useCatalog();
  const campaign = useCampaign().data?.campaign;
  const offerLive = campaign?.state === 'open';

  return (
    <>
      <section className="relative overflow-hidden pt-28 md:pt-36">
        <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:px-8">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="blue" icon={<Sparkles className="h-3.5 w-3.5" />}>Now serving Kharadi, Pune</Badge>
              {campaign && campaign.state !== 'full' && (
                <Link to="/navratri" className="inline-flex items-center gap-1.5 rounded-full border border-offer/30 bg-offer/12 px-2.5 py-1 text-[11px] font-semibold text-offer transition-colors hover:bg-offer/20">
                  <Gift className="h-3.5 w-3.5" aria-hidden /> {campaign.name}: free {audience(campaign).short} <ArrowRight className="h-3 w-3" aria-hidden />
                </Link>
              )}
            </div>
            <h1 className="sr-only">Wake up to a spotless ride. Doorstep car and bike washing in Kharadi, Pune.</h1>
            <div aria-hidden className="mt-5 font-display text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
              {reduceMotion ? <span className="block">Wake up to a spotless ride.</span> : <BlurText text="Wake up to a spotless ride." delay={90} animateBy="words" direction="top" className="flex-wrap" />}
              <RotatingLine className="mt-2 text-washo-300" phrases={['Washed at your doorstep.', 'Zero queues, zero effort.', 'Shine, delivered every week.', 'Done before your first coffee.']} />
            </div>
            <p className="mt-5 max-w-xl text-lg text-mist">Doorstep car and bike washing in Kharadi, Pune. Choose how many washes you want each month (4 or more), on the days you choose. We call ahead, wash at your parking spot and send before and after photos.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              {/* React Bits StarBorder: the primary call to action */}
              <StarBorder as={Link} to="/app/membership/new" color="#6a9cff" speed="5s" backgroundColor="#1248b8" borderColor="rgba(155,191,255,0.35)" className="rounded-2xl" aria-label="Build my membership">
                <span className="flex items-center gap-2 text-base font-semibold">Build my membership <ArrowRight className="h-5 w-5" /></span>
              </StarBorder>
              <ButtonLink to="/services" size="lg" variant="glass">See services</ButtonLink>
            </div>
          </div>
          <div className="mx-auto w-full max-w-sm"><AvatarFull priority /></div>
        </div>
        {/* React Bits Split Flap Text: the WASHO tagline, clacking round like a departure board, across the full width */}
        <div aria-hidden className="mx-auto mt-12 max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex justify-center">
            <SplitFlapText
              words={offerLive ? ['CLEAN TODAY', 'SHINE EVERYDAY', 'FREE WASH', 'DOORSTEP WASH', 'KHARADI PUNE'] : ['CLEAN TODAY', 'SHINE EVERYDAY', 'DOORSTEP WASH', 'KHARADI PUNE']}
              padTo={14}
              fontSize="clamp(21px, 6.2vw, 76px)"
              gap="clamp(3px, 0.6vw, 8px)"
              tileRadius="clamp(4px, 0.8vw, 10px)"
              tileColor="#111a2f"
              textColor="#cfe0ff"
              cycleDelay={3200}
            />
          </div>
        </div>
      </section>

      <section id="how" className="mx-auto max-w-7xl scroll-mt-24 px-4 py-20 sm:px-6 lg:px-8">
        <Reveal><p className="eyebrow">How it works</p><h2 className="mt-2 text-3xl font-extrabold md:text-4xl">From request to a sparkling car</h2></Reveal>
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <Reveal key={s.title} delay={i * 0.06} className="glass p-6">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-washo-500/15 text-washo-300"><s.icon className="h-6 w-6" /></span>
              <p className="mt-4 text-xs font-semibold text-fog">Step {i + 1}</p>
              <h3 className="mt-1 text-lg font-bold">{s.title}</h3>
              <p className="mt-2 text-sm text-fog">{s.text}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <ComboPacks />

      <section id="membership" className="mx-auto max-w-7xl scroll-mt-24 px-4 pb-20 sm:px-6 lg:px-8">
        <div className="glass grid items-center gap-8 p-6 md:p-10 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="eyebrow">Custom membership</p>
            <h2 className="mt-2 text-3xl font-extrabold md:text-4xl">You design it. We take care of the rest.</h2>
            <ul className="mt-6 space-y-3 text-mist">
              <li><strong className="text-white">Body washes and Deep cleans:</strong> choose how many of each you want every month, any mix, at least 4 in all.</li>
              <li><strong className="text-white">Your days:</strong> tell us which days suit you for each, and we manage your whole month accordingly.</li>
              <li><strong className="text-white">1, 3, 6 or 12 months.</strong> Reschedule any wash anytime.</li>
            </ul>
            <ButtonLink to="/app/membership/new" className="mt-8" iconRight={<ArrowRight className="h-5 w-5" />}>Build my plan</ButtonLink>
          </div>
          <div className="panel space-y-3 p-6">
            <p className="eyebrow">Pay once, we start</p>
            <p className="text-sm text-mist">See your price as you build the plan, pay securely with Razorpay, and your washes are scheduled as soon as the payment is verified.</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8">
        <Reveal><p className="eyebrow">Single washes</p><h2 className="mt-2 text-3xl font-extrabold md:text-4xl">Or book one wash</h2></Reveal>
        <div className="mt-6">{isLoading || !catalog ? <Skeleton className="h-[560px]" /> : <ServiceCarousel services={catalog.services} />}</div>
        <p className="mt-4 text-xs text-fog">SUVs use the car Body wash rate and the SUV Deep cleaning rate.</p>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
        <Reveal><p className="eyebrow">Why WASHO</p><h2 className="mt-2 text-3xl font-extrabold md:text-4xl">A careful wash, right at your parking spot</h2></Reveal>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {why.map((w, i) => (
            <Reveal key={w.title} delay={i * 0.04} className="panel p-6"><w.icon className="h-6 w-6 text-washo-300" /><h3 className="mt-3 font-bold">{w.title}</h3><p className="mt-1.5 text-sm text-fog">{w.text}</p></Reveal>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-28 sm:px-6 lg:px-8" aria-labelledby="card-title">
        <div className="glass grid items-center gap-6 overflow-hidden p-6 md:p-10 lg:grid-cols-2">
          <Reveal>
            <p className="eyebrow">Your WASHO card</p>
            <h2 id="card-title" className="mt-2 text-3xl font-extrabold md:text-4xl">Clean today, shine every day.</h2>
            <p className="mt-4 max-w-md text-mist">Build a plan once and your washes are scheduled for you: your days, your slot, a call before every wash and before and after photos. Give the card a swing, then start yours.</p>
            <ButtonLink to="/app/membership/new" className="mt-8" iconRight={<ArrowRight className="h-5 w-5" />}>Build my plan</ButtonLink>
          </Reveal>
          <div ref={lanyardRef} className="relative mx-auto h-[540px] w-full max-w-[460px] sm:h-[620px]" role="img" aria-label="A WASHO member card hanging from a lanyard. Drag it to swing it.">
            <Suspense fallback={<img src={cardFront} alt="" width={320} height={447} className="mx-auto mt-24 w-56 rounded-2xl" />}>
              {lanyardNear
                ? <Lanyard frontImage={cardFront} backImage={cardBack} orientation="portrait" size={0.72} strapLength={0.38} strapColor="#16284d" strapWidth={0.7} metal="silver" finish="glossy" cornerRadius={0.3} />
                : <img src={cardFront} alt="" width={320} height={447} className="mx-auto mt-24 w-56 rounded-2xl" />}
            </Suspense>
          </div>
        </div>
      </section>
    </>
  );
}
