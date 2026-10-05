import { AnimatePresence, motion } from 'framer-motion';
import { Check, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { CountPrice, anchorTotalCents } from './CountPrice';
import { VehicleToggle } from './VehicleToggle';
import SpotlightCard from './reactbits/SpotlightCard';
import { Badge } from './ui/Badge';
import { ButtonLink } from './ui/Button';
import { Reveal } from './ui/Reveal';
import { Skeleton } from './ui/Skeleton';
import { cn } from '../lib/cn';
import { percent, rupees, vehicleLabel } from '../lib/format';
import { defaultPattern, useCatalog, useEstimate } from '../lib/queries';
import { VEHICLE_PHOTOS } from '../lib/serviceImages';
import type { VehicleType } from '../lib/types';

const PACKS = {
  1: { name: 'Starter', blurb: 'A regular wash to keep it looking cared for.' },
  2: { name: 'Balanced', blurb: 'A body wash plus a deep clean every week.' },
  3: { name: 'Premium', blurb: 'Three visits per week for a vehicle that always shines.' },
} as const;
type PerWeek = keyof typeof PACKS;

/** One photo, one toggle: the vehicle picks the photo and the number of washes per week switches the pack's contents and price. */
export function ComboPacks() {
  const [vehicle, setVehicle] = useState<VehicleType>('car');
  const [n, setN] = useState<PerWeek>(2);
  const pack = PACKS[n];
  const { data, isError } = useEstimate({ vehicle_type: vehicle, weekly_pattern: defaultPattern(vehicle, n), duration_months: 1 });
  const saving = data && data.total_discount_cents > 0;
  // What one wash costs for this vehicle, from the rate card (an SUV's body wash is the car body wash).
  const { data: catalog } = useCatalog();
  const rate = (kind: 'body' | 'deep') => {
    const option = catalog?.membership_options.find((o) => o.vehicle_type === vehicle && o.wash_kind === kind);
    const service = option && catalog?.services.find((x) => x.code === option.service_code);
    const cents = service?.unit_prices?.find((p) => p.vehicle_type === vehicle)?.price_cents;
    return service && cents != null ? { code: service.code, cents } : null;
  };
  const rates = (vehicle === 'bike' ? [['Bike wash', rate('body')]] : [['Body wash', rate('body')], ['Deep cleaning', rate('deep')]]) as [string, { code: string; cents: number } | null][];

  return (
    <section id="packs" className="mx-auto max-w-7xl scroll-mt-24 px-4 pb-20 sm:px-6 lg:px-8">
      <Reveal>
        <p className="eyebrow">Combo packs</p>
        <h2 className="mt-2 text-3xl font-extrabold md:text-4xl">Pick a pack, then make it yours</h2>
        <p className="mt-3 max-w-2xl text-fog">Choose your vehicle and how many washes per week. Start from the pack and change the days, the mix and the length when you build your plan. Prices come straight from our per-wash rates.</p>
      </Reveal>
      <div className="mt-6 max-w-sm">
        <VehicleToggle value={vehicle} onChange={setVehicle} className="w-full" />
      </div>
      <div className="mt-3 flex min-h-9 flex-wrap items-center gap-2" aria-live="polite">
        <span className="text-[13px] font-medium text-mist">Price per wash</span>
        {rates.map(([label, r]) => r && (
          <span key={`${vehicle}-${label}`} className="inline-flex items-baseline gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-sm">
            <span className="text-fog">{label}</span>
            <CountPrice className="font-display font-extrabold tabular-nums" cents={r.cents} code={r.code} />
          </span>
        ))}
      </div>

      <Reveal className="mt-6">
        <SpotlightCard spotlightColor="rgba(63, 124, 255, 0.22)" className="grid overflow-hidden rounded-3xl! border-white/[0.09]! bg-white/[0.045]! p-0! backdrop-blur-xl md:grid-cols-2">
          <div className="relative aspect-square overflow-hidden bg-ink-900 md:aspect-auto md:min-h-[30rem]">
            <AnimatePresence initial={false}>
              <motion.img
                key={vehicle}
                src={VEHICLE_PHOTOS[vehicle]}
                alt={`A WASHO specialist washing a ${vehicleLabel[vehicle].toLowerCase()}`}
                loading="lazy"
                decoding="async"
                initial={{ opacity: 0, scale: 1.04 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.45 }}
                className="absolute inset-0 h-full w-full object-cover object-[center_30%]"
              />
            </AnimatePresence>
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink-950/70 via-transparent to-transparent" />
            <div className="absolute bottom-4 left-4 flex flex-wrap gap-2">
              <Badge tone="blue">{vehicleLabel[vehicle]}</Badge>
              <Badge>{n} wash{n > 1 ? 'es' : ''} per week</Badge>
            </div>
          </div>

          <div className="flex flex-col p-6 md:p-8">
            <p className="text-[13px] font-medium text-mist">Washes per week</p>
            <div role="radiogroup" aria-label="Washes per week" className="mt-2 grid grid-cols-3 gap-1.5 rounded-2xl border border-white/[0.09] bg-white/[0.03] p-1.5">
              {([1, 2, 3] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={n === k} onClick={() => setN(k)} className={cn('relative grid h-14 place-items-center rounded-xl font-display text-2xl font-extrabold transition-colors', n === k ? 'text-white' : 'text-fog hover:text-white')}>
                  {n === k && <motion.span layoutId="pack-pill" className="absolute inset-0 rounded-xl border border-washo-400/60 bg-washo-500/30 shadow-[0_0_24px_-8px_rgb(63_124_255/0.8)]" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
                  <span className="relative">{k}</span>
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={`${vehicle}-${n}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }} className="mt-6 flex flex-1 flex-col" aria-live="polite">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="eyebrow">{pack.name}</p>
                    <h3 className="mt-1 text-2xl font-bold">{n} wash{n > 1 ? 'es' : ''} per week</h3>
                  </div>
                  {saving && <Badge tone="yellow" icon={<Sparkles className="h-3 w-3" />}>{percent(data.frequency_discount.bp)} off</Badge>}
                </div>
                <p className="mt-1.5 text-sm text-fog">{pack.blurb}</p>
                <ul className="mt-4 space-y-2 text-sm text-mist">
                  {data ? (
                    <>
                      {data.lines.map((l) => (
                        <li key={l.name} className="flex items-center gap-2"><Check className="h-4 w-4 shrink-0 text-ok" strokeWidth={3} /> {l.quantity} × {l.name} a month</li>
                      ))}
                      <li className="flex items-center gap-2"><Check className="h-4 w-4 shrink-0 text-ok" strokeWidth={3} /> Doorstep service, specialist calls ahead, before and after photos</li>
                    </>
                  ) : (
                    <Skeleton className="h-5 w-3/4" />
                  )}
                </ul>

                <div className="mt-auto pt-6">
                  {isError ? (
                    <p className="text-sm text-fog">Price shown when you build your plan.</p>
                  ) : data ? (
                    <p className="flex items-baseline gap-2">
                      <CountPrice className="font-display text-4xl font-extrabold tabular-nums" cents={data.final_cents} fromCents={anchorTotalCents(data.lines)} />
                      <span className="text-sm text-fog">/ month</span>
                      {saving && <span className="text-sm tabular-nums text-fog line-through">{rupees(data.subtotal_cents)}</span>}
                    </p>
                  ) : (
                    <Skeleton className="h-10 w-36" />
                  )}
                  {data && !isError && <p className="mt-1 text-sm text-mist">About {rupees(Math.round(data.final_cents / data.washes_total))} per wash on this pack</p>}
                  <p className="mt-1 text-xs text-fog">Price for a {vehicleLabel[vehicle].toLowerCase()}, 1 month. Change the days, mix and length when you build your plan.</p>
                  <ButtonLink to={`/app/membership/new?perWeek=${n}&type=${vehicle}`} full size="lg" className="mt-4">Choose this pack</ButtonLink>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </SpotlightCard>
      </Reveal>
      <p className="mt-5 text-sm text-fog">Want more? Choose any number of washes from 1 to 7 per week when you build your plan, with the price updating as you go.</p>
    </section>
  );
}
