import { ServiceArt } from '../components/brand/ServiceArt';
import SpotlightCard from '../components/reactbits/SpotlightCard';
import { Badge } from '../components/ui/Badge';
import { ButtonLink } from '../components/ui/Button';
import { ErrorState } from '../components/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { duration, rupees, vehicleLabel } from '../lib/format';
import { useCatalog } from '../lib/queries';

const art = (code: string) => (code.startsWith('bike') ? 'bike_wash' : code.startsWith('suv') ? 'suv_deep_clean' : code.includes('deep') ? 'car_deep_clean' : 'car_body_wash');

export default function Services() {
  const { data, isLoading, isError, error, refetch } = useCatalog();
  return (
    <div className="mx-auto max-w-7xl px-4 pb-24 pt-28 sm:px-6 lg:px-8">
      <p className="eyebrow">Services</p>
      <h1 className="mt-2 text-4xl font-extrabold">Every wash, one clear price</h1>
      <p className="mt-3 max-w-2xl text-fog">Single washes are priced from our rate card. For regular washing, a custom membership is better value, and WASHO quotes it for you.</p>
      {isError && <div className="mt-10"><ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} /></div>}
      <div className="mt-10 grid gap-5 md:grid-cols-2">
        {isLoading ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-72" />) : data?.services.map((s) => (
          <SpotlightCard key={s.id} spotlightColor="rgba(63, 124, 255, 0.25)" className="grid rounded-3xl! border-white/[0.09]! bg-white/[0.045]! p-0! backdrop-blur-xl sm:grid-cols-[0.9fr_1.1fr]">
            <div className="aspect-[400/260] sm:aspect-auto"><ServiceArt scene={art(s.code)} /></div>
            <div className="p-6">
              <div className="flex flex-wrap items-center gap-2"><Badge tone="blue">{vehicleLabel[s.vehicle_type]}</Badge>{s.duration_minutes && <Badge>{duration(s.duration_minutes)}</Badge>}</div>
              <h2 className="mt-3 text-xl font-bold">{s.name}</h2>
              <p className="mt-1 text-sm text-fog">{s.description ?? s.tagline}</p>
              {s.includes && <ul className="mt-3 space-y-1 text-sm text-mist">{s.includes.map((i) => <li key={i}>• {i}</li>)}</ul>}
              <div className="mt-4 flex flex-wrap gap-4">{s.unit_prices?.map((p) => <p key={p.vehicle_type}><span className="font-display text-2xl font-extrabold">{rupees(p.price_cents)}</span><span className="ml-1 text-xs text-fog">{vehicleLabel[p.vehicle_type]}</span></p>)}</div>
            </div>
          </SpotlightCard>
        ))}
      </div>
      <div className="mt-10 flex flex-wrap gap-3"><ButtonLink to="/app/membership/new" size="lg">Build a membership</ButtonLink><ButtonLink to="/app/book" size="lg" variant="glass">Book a single wash</ButtonLink></div>
    </div>
  );
}
