import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { ServiceArt } from './brand/ServiceArt';
import SpotlightCard from './reactbits/SpotlightCard';
import { Badge } from './ui/Badge';
import { ButtonLink } from './ui/Button';
import { Reveal } from './ui/Reveal';
import { Segmented } from './ui/Segmented';
import { Skeleton } from './ui/Skeleton';
import { percent, rupees, vehicleLabel } from '../lib/format';
import { defaultPattern, useEstimate } from '../lib/queries';
import type { VehicleType } from '../lib/types';

const PACKS = [
  { n: 1, name: 'Starter', blurb: 'A regular wash to keep it looking cared for.', scene: (v: VehicleType) => (v === 'bike' ? 'bike_wash' : 'car_body_wash') },
  { n: 2, name: 'Balanced', blurb: 'Body wash plus a deep clean every week.', scene: (v: VehicleType) => (v === 'bike' ? 'bike_wash' : v === 'suv' ? 'suv_deep_clean' : 'car_deep_clean') },
  { n: 3, name: 'Premium', blurb: 'Three visits a week for a car that always shines.', scene: (v: VehicleType) => (v === 'bike' ? 'bike_wash' : v === 'suv' ? 'suv_deep_clean' : 'car_deep_clean') },
] as const;

/**
 * Photo for a pack: drop /public/packs/combo-1.webp, combo-2.webp, combo-3.webp (landscape, about 1200x800) and they are used
 * automatically. Until then the illustrated scene is shown.
 */
function PackImage({ n, scene }: { n: number; scene: string }) {
  const [missing, setMissing] = useState(false);
  return (
    <div className="relative aspect-[3/2] overflow-hidden bg-ink-900">
      {missing ? (
        <ServiceArt scene={scene} />
      ) : (
        <img src={`/packs/combo-${n}.webp`} alt="" loading="lazy" decoding="async" onError={() => setMissing(true)} className="h-full w-full object-cover" />
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-ink-950/70 to-transparent" />
    </div>
  );
}

function Pack({ n, vehicle, index }: { n: 1 | 2 | 3; vehicle: VehicleType; index: number }) {
  const pack = PACKS[n - 1];
  const { data, isError } = useEstimate({ vehicle_type: vehicle, weekly_pattern: defaultPattern(vehicle, n), duration_months: 1 });
  const saving = data && data.total_discount_cents > 0;
  return (
    <Reveal delay={index * 0.06}>
      <SpotlightCard spotlightColor="rgba(63, 124, 255, 0.28)" className="flex h-full flex-col rounded-3xl! border-white/[0.09]! bg-white/[0.045]! p-0! backdrop-blur-xl">
        <PackImage n={n} scene={pack.scene(vehicle)} />
        <div className="flex flex-1 flex-col p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="eyebrow">{pack.name}</p>
              <h3 className="mt-1 text-xl font-bold">{n} wash{n > 1 ? 'es' : ''} a week</h3>
            </div>
            {saving && <Badge tone="yellow" icon={<Sparkles className="h-3 w-3" />}>{percent(data.frequency_discount.bp)} off</Badge>}
          </div>
          <p className="mt-1.5 text-sm text-fog">{pack.blurb}</p>
          <ul className="mt-4 space-y-1.5 text-sm text-mist">
            {data ? data.lines.map((l) => <li key={l.name}>{l.quantity} × {l.name} a month</li>) : <Skeleton className="h-4 w-3/4" />}
          </ul>
          <div className="mt-auto pt-5">
            {isError ? (
              <p className="text-sm text-fog">Price shown when you build your plan.</p>
            ) : data ? (
              <p className="flex items-baseline gap-2">
                <span className="font-display text-3xl font-extrabold tabular-nums">{rupees(data.final_cents)}</span>
                <span className="text-sm text-fog">/ month</span>
                {saving && <span className="text-sm tabular-nums text-fog line-through">{rupees(data.subtotal_cents)}</span>}
              </p>
            ) : (
              <Skeleton className="h-9 w-32" />
            )}
            <p className="mt-1 text-xs text-fog">Estimate for {vehicleLabel[vehicle].toLowerCase()}, 1 month. WASHO confirms the final price.</p>
            <ButtonLink to={`/app/membership/new?perWeek=${n}&type=${vehicle}`} full className="mt-4">Choose this pack</ButtonLink>
          </div>
        </div>
      </SpotlightCard>
    </Reveal>
  );
}

export function ComboPacks() {
  const [vehicle, setVehicle] = useState<VehicleType>('car');
  return (
    <section id="packs" className="mx-auto max-w-7xl scroll-mt-24 px-4 pb-20 sm:px-6 lg:px-8">
      <Reveal>
        <p className="eyebrow">Combo packs</p>
        <h2 className="mt-2 text-3xl font-extrabold md:text-4xl">Pick a pack, then make it yours</h2>
        <p className="mt-3 max-w-2xl text-fog">Start from a pack and change the days, the mix and the length when you build your plan. Prices come straight from our per-wash rates.</p>
      </Reveal>
      <div className="mt-6 max-w-sm">
        <Segmented label="Vehicle" value={vehicle} onChange={setVehicle} options={[{ value: 'bike', label: 'Bike' }, { value: 'car', label: 'Car' }, { value: 'suv', label: 'SUV' }]} />
      </div>
      <div className="mt-8 grid gap-5 md:grid-cols-3">
        {([1, 2, 3] as const).map((n, i) => <Pack key={`${vehicle}-${n}`} n={n} vehicle={vehicle} index={i} />)}
      </div>
      <p className="mt-5 text-sm text-fog">Want more? Choose any number of washes from 1 to 7 a week when you build your plan, with the price updating as you go.</p>
    </section>
  );
}
