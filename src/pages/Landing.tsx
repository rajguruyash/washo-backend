import { ArrowRight, CalendarCheck, Camera, Droplets, Leaf, MessageSquareText, ShieldCheck, Sparkles, Timer, UserCheck, Users, Wallet } from 'lucide-react';
import { AvatarFull } from '../components/brand/Avatar';
import { ServicePhoto } from '../components/ServicePhoto';
import { Badge } from '../components/ui/Badge';
import { ButtonLink } from '../components/ui/Button';
import BlurText from '../components/reactbits/BlurText';
import CountUp from '../components/reactbits/CountUp';
import SpotlightCard from '../components/reactbits/SpotlightCard';
import StarBorder from '../components/reactbits/StarBorder';
import { ComboPacks } from '../components/ComboPacks';
import { Reveal } from '../components/ui/Reveal';
import { Link } from 'react-router-dom';
import { Skeleton } from '../components/ui/Skeleton';
import { percent, rupees } from '../lib/format';
import { useCatalog } from '../lib/queries';

const steps = [
  { icon: CalendarCheck, title: 'Build your plan', text: 'Pick your vehicle, 1 to 7 washes a week, the days, and how long. The estimate updates as you go.' },
  { icon: MessageSquareText, title: 'WASHO sends your price', text: 'We review your request and send a clear quote. Every discount is a labelled line.' },
  { icon: Wallet, title: 'Accept and pay securely', text: 'Pay only after you accept. Your washes are scheduled once the payment is verified.' },
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
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const { data: catalog, isLoading } = useCatalog();
  const freq = catalog?.discounts.filter((d) => d.kind === 'frequency' && d.discount_bp > 0) ?? [];
  const dur = catalog?.discounts.filter((d) => d.kind === 'duration' && d.discount_bp > 0) ?? [];

  return (
    <>
      <section className="relative overflow-hidden pt-28 md:pt-36">
        <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:px-8">
          <div>
            <Badge tone="blue" icon={<Sparkles className="h-3.5 w-3.5" />}>Now serving Kharadi, Pune</Badge>
            <h1 className="sr-only">Your car and bike, washed on schedule, at your doorstep.</h1>
            <div aria-hidden className="mt-5 font-display text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
              <div>
                {reduceMotion ? 'Your car and bike,' : <BlurText text="Your car and bike," delay={90} animateBy="words" direction="top" className="flex-wrap" />}
                {reduceMotion ? <span className="block text-washo-300">washed on schedule, at your doorstep.</span> : <BlurText text="washed on schedule, at your doorstep." delay={90} animateBy="words" direction="top" className="flex-wrap text-washo-300" />}
              </div>
            </div>
            <p className="mt-5 max-w-xl text-lg text-mist">Build a custom WASHO membership: 1 to 7 washes a week, on the days you choose. We quote it, you approve it, and we take care of the rest.</p>
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
        <div className="glass grid gap-8 p-6 md:p-10 lg:grid-cols-2">
          <div>
            <p className="eyebrow">Custom membership</p>
            <h2 className="mt-2 text-3xl font-extrabold md:text-4xl">You design it. WASHO prices it.</h2>
            <ul className="mt-6 space-y-3 text-mist">
              <li><strong className="text-white">1 to 7 washes a week:</strong> you choose the number and the days.</li>
              <li><strong className="text-white">1 a week:</strong> one wash type, Body or Deep.</li>
              <li><strong className="text-white">2 a week:</strong> one Body wash and one Deep cleaning.</li>
              <li><strong className="text-white">3 or more:</strong> a mix of Body washes and Deep cleanings.</li>
              <li><strong className="text-white">1, 3, 6 or 12 months.</strong> Reschedule any wash anytime.</li>
            </ul>
            <ButtonLink to="/app/membership/new" className="mt-8" iconRight={<ArrowRight className="h-5 w-5" />}>Start my request</ButtonLink>
          </div>
          <div>
            <p className="eyebrow">Transparent discounts</p>
            {isLoading ? <Skeleton className="mt-4 h-40" /> : (
              <div className="mt-4 space-y-3">
                {freq.map((d) => <div key={`f${d.key}`} className="panel flex items-center justify-between p-4"><span>{d.label || `${d.key} washes a week`}</span><Badge tone="yellow"><CountUp to={d.discount_bp / 100} duration={1.2} />% off</Badge></div>)}
                {dur.map((d) => <div key={`d${d.key}`} className="panel flex items-center justify-between p-4"><span>{d.label || `${d.key} months`}</span><Badge tone="yellow"><CountUp to={d.discount_bp / 100} duration={1.2} />% off</Badge></div>)}
                {catalog && <p className="text-xs text-fog">Discounts combine up to {percent(catalog.max_total_discount_bp)} in total. Your quote shows each one as its own line.</p>}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8">
        <Reveal><p className="eyebrow">Single washes</p><h2 className="mt-2 text-3xl font-extrabold md:text-4xl">Or book one wash</h2></Reveal>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {isLoading ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64" />) : catalog?.services.map((s, i) => {
            const own = s.unit_prices?.find((p) => p.vehicle_type === s.vehicle_type)?.price_cents;
            return (
              <Reveal key={s.id} delay={i * 0.05}>
                <SpotlightCard spotlightColor="rgba(63, 124, 255, 0.28)" className="h-full rounded-3xl! border-white/[0.09]! bg-white/[0.045]! p-0! backdrop-blur-xl">
                  <ServicePhoto code={s.code} name={s.name} className="aspect-[4/3]" />
                  <div className="p-5"><h3 className="font-bold">{s.name}</h3><p className="mt-1 text-sm text-fog">{s.tagline ?? s.description}</p>{own != null && <p className="mt-3 font-display text-2xl font-extrabold">{rupees(own)}</p>}</div>
                </SpotlightCard>
              </Reveal>
            );
          })}
        </div>
        <p className="mt-4 text-xs text-fog">SUVs use the car Body wash rate and the SUV Deep cleaning rate.</p>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
        <Reveal><p className="eyebrow">Why WASHO</p><h2 className="mt-2 text-3xl font-extrabold md:text-4xl">Care your vehicle can feel</h2></Reveal>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {why.map((w, i) => (
            <Reveal key={w.title} delay={i * 0.04} className="panel p-6"><w.icon className="h-6 w-6 text-washo-300" /><h3 className="mt-3 font-bold">{w.title}</h3><p className="mt-1.5 text-sm text-fog">{w.text}</p></Reveal>
          ))}
        </div>
      </section>
    </>
  );
}
