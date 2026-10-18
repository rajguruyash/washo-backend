import { Check, Clock, MapPin, Package, UserRound } from 'lucide-react';
import { duration, friendlyDay } from '../lib/format';
import { slotLabel, slotWindow } from '../lib/slots';
import type { PoolWash } from '../lib/types';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';

/**
 * An unclaimed wash with everything a specialist can be told before taking it: when, what the service includes and how long it takes, the vehicle, the society, building and
 * parking spot, and the time the customer wants it done by. Who the customer is (name, number, flat) and the number plate appear once the wash is claimed.
 */
export function PoolWashCard({ p, onClaim, claiming, bare }: { p: PoolWash; onClaim: () => void; claiming: boolean; bare?: boolean }) {
  const vehicle = [p.vehicle_type.toUpperCase(), [p.vehicle_make, p.vehicle_model].filter(Boolean).join(' '), p.vehicle_color].filter(Boolean).join(' · ');
  const place = [p.society_name, p.building_block && `Block ${p.building_block}`].filter(Boolean).join(', ');
  const area = [p.area_locality, p.city].filter(Boolean).join(', ');
  const includes = Array.isArray(p.service_includes) ? p.service_includes.filter((x): x is string => typeof x === 'string') : [];
  return (
    <div className={bare ? 'space-y-3' : 'glass space-y-3 p-4'}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-washo-300">{friendlyDay(p.scheduled_date)} · {slotLabel(p.time_slot)} <span className="font-normal normal-case text-fog">{slotWindow(p.time_slot)}</span></p>
          <p className="mt-1 text-lg font-bold">{p.service_name}</p>
        </div>
        {p.booking_type === 'membership' && <Badge tone="blue">Membership wash</Badge>}
      </div>

      <dl className="space-y-1.5 text-sm">
        <div className="flex items-start gap-2"><Package className="mt-0.5 h-4 w-4 shrink-0 text-fog" aria-hidden /><div><dt className="sr-only">Vehicle</dt><dd>{vehicle}</dd></div></div>
        <div className="flex items-start gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-fog" aria-hidden /><div><dt className="sr-only">Where</dt><dd>{place || 'Society not given'}{area && <span className="block text-fog">{area}</span>}{p.parking_location && <span className="block text-fog">Parked at {p.parking_location}</span>}</dd></div></div>
        {(p.duration_minutes || p.target_completion_time) && (
          <div className="flex items-start gap-2"><Clock className="mt-0.5 h-4 w-4 shrink-0 text-fog" aria-hidden /><div><dt className="sr-only">Time</dt><dd>{[p.duration_minutes ? `About ${duration(p.duration_minutes)}` : null, p.target_completion_time ? `Customer wants it done by ${p.target_completion_time}` : null].filter(Boolean).join(' · ')}</dd></div></div>
        )}
      </dl>

      {includes.length > 0 && (
        <div>
          <p className="eyebrow">Includes</p>
          <ul className="mt-1.5 grid gap-x-4 gap-y-1 text-sm text-mist sm:grid-cols-2">
            {includes.map((x) => <li key={x} className="flex items-start gap-1.5"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />{x}</li>)}
          </ul>
        </div>
      )}

      <p className="flex items-start gap-2 text-xs text-fog"><UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> The customer&rsquo;s name, number, flat and number plate appear after you claim this wash.</p>
      <Button full loading={claiming} onClick={onClaim}>Claim this wash</Button>
    </div>
  );
}
