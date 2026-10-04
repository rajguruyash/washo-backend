import { useEffect, useMemo, useRef, useState } from 'react';
import { servicePhoto } from '../lib/serviceImages';
import type { CatalogService } from '../lib/types';
import { CountPrice } from './CountPrice';
import CircularCarousel from './reactbits/CircularCarousel';

// A ring needs enough cards around it to look like a ring: with only WASHO's four services the neighbours would sit out of view,
// so the set goes round REPEAT times. The caption below is ours (not the carousel's) so it counts services, not cards.
const REPEAT = 3;

/** The price under the ring. It counts down the first time each service comes round, then just shows the price. */
function CaptionPrice({ code, cents, tagline, seen }: { code: string; cents: number | null; tagline: string; seen: Set<string> }) {
  const [animate] = useState(() => !seen.has(code));
  useEffect(() => {
    seen.add(code);
  }, [code, seen]);
  if (cents == null) return <p className="text-fog">{tagline}</p>;
  return <p className="text-fog"><CountPrice cents={cents} code={code} animate={animate} /> a wash</p>;
}

/** WASHO's services as a turning ring of photos: each card shows the service and what one wash of it costs. */
export function ServiceCarousel({ services }: { services: CatalogService[] }) {
  const [active, setActive] = useState(0);
  const seen = useRef(new Set<string>());
  const base = useMemo(
    () =>
      services.flatMap((s) => {
        const src = servicePhoto(s.code);
        if (!src) return [];
        const own = s.unit_prices?.find((p) => p.vehicle_type === s.vehicle_type)?.price_cents ?? null;
        return [{ src, alt: `${s.name}: a WASHO specialist at work`, title: s.name, code: s.code, cents: own, tagline: s.tagline ?? '' }];
      }),
    [services]
  );
  // The ring drifts towards the lower numbers, so it is laid out back to front: the services then come round in their own order.
  const ring = useMemo(() => [...base].reverse(), [base]);
  const items = useMemo(() => Array.from({ length: REPEAT }, () => ring.map(({ src, alt, title }) => ({ src, alt, title }))).flat(), [ring]);
  if (!base.length) return null;
  const slot = active % ring.length;
  const now = ring[slot];
  return (
    <div>
    <div className="relative h-[400px] w-full sm:h-[470px]">
      <CircularCarousel
        items={items}
        onChange={setActive}
        preset="panorama"
        intro="spin"
        cardWidth={248}
        aspectRatio={0.75}
        speed={14}
        gap={68}
        tilt={0}
        curve={0.01}
        perspective={1800}
        momentum={0.4}
        stretch={0.56}
        depthFade={0}
        innerShade={0.06}
        cornerRadius={9}
        fadeColor="#05080f"
      />
    </div>
    <div className="mt-2 text-center" aria-hidden>
      <p className="font-display text-lg font-bold">{now.title}</p>
      <CaptionPrice key={now.code} code={now.code} cents={now.cents} tagline={now.tagline} seen={seen.current} />
      <p className="mt-1 text-xs tabular-nums text-fog/70">{String(ring.length - slot).padStart(2, '0')} / {String(base.length).padStart(2, '0')}</p>
    </div>
    </div>
  );
}
