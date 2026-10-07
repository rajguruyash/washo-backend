import { ArrowLeft, CalendarClock, Camera, CheckCircle2, ChevronRight, PartyPopper } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Plate } from '../../components/brand/Plate';
import { ErrorState } from '../../components/EmptyState';
import { RescheduleSheet } from '../../components/RescheduleSheet';
import { WashDoneSheet } from '../../components/WashDoneSheet';
import { CustomerStatus, patternLabel } from '../../components/WashBits';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Segmented } from '../../components/ui/Segmented';
import { Skeleton } from '../../components/ui/Skeleton';
import { fullDate, istDay, prettyDate, rupees } from '../../lib/format';
import { useMembership } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { isLive } from '../../lib/status';
import type { MembershipWash } from '../../lib/types';

export default function MembershipDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { data, isLoading, isError, refetch } = useMembership(id);
  const [tab, setTab] = useState<'upcoming' | 'completed' | 'other'>(params.get('tab') === 'completed' ? 'completed' : 'upcoming');
  const [viewing, setViewing] = useState<MembershipWash | null>(null);
  const [moving, setMoving] = useState<MembershipWash | null>(null);

  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !data) return <div className="space-y-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-48" /><Skeleton className="h-64" /></div>;
  const { membership: m, washes } = data;
  const upcoming = washes.filter((w) => isLive(w.status));
  const completed = washes.filter((w) => w.status === 'completed');
  const other = washes.filter((w) => !isLive(w.status) && w.status !== 'completed');
  const list = tab === 'upcoming' ? upcoming : tab === 'completed' ? completed : other;
  const endDate = istDay(m.end_at);
  const services = [...new Set(washes.map((w) => w.service_name))];

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/app/membership" className="mb-5 inline-flex items-center gap-1.5 text-sm text-fog hover:text-white"><ArrowLeft className="h-4 w-4" /> Membership</Link>
      {params.get('new') && (
        <div className="glass mb-6 flex items-start gap-4 border-ok/30 p-5"><PartyPopper className="h-7 w-7 shrink-0 text-ok" /><div><p className="font-bold">Payment verified. Your membership is active!</p><p className="text-sm text-fog">All {washes.length} washes are scheduled below. You can reschedule any of them.</p></div></div>
      )}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">{m.reference_code}</p>
          <h1 className="mt-1 text-3xl font-extrabold">{m.frequency_per_week} wash{(m.frequency_per_week ?? 0) > 1 ? 'es' : ''} per week · {m.duration_months} month{m.duration_months > 1 ? 's' : ''}</h1>
        </div>
        <Badge tone={m.status === 'active' ? 'green' : 'slate'} icon={<CheckCircle2 className="h-3.5 w-3.5" />}>{m.status === 'active' ? 'Active' : m.status}</Badge>
      </div>

      <div className="glass divide-y divide-white/[0.07]">
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <div><p className="eyebrow">Vehicle</p><div className="mt-2 flex items-center gap-3"><p className="font-bold">{m.vehicle_model}</p>{m.registration_number && <Plate reg={m.registration_number} />}</div></div>
          <div><p className="eyebrow">Services</p><p className="mt-1 text-sm">{services.join(' · ')}</p></div>
          <div><p className="eyebrow">Weekly schedule</p><p className="mt-1 text-sm">{m.weekly_pattern ? patternLabel(m.weekly_pattern) : '—'}{m.time_slot ? ` · ${slotLabel(m.time_slot)}` : ''}</p></div>
          <div><p className="eyebrow">Term</p><p className="mt-1 text-sm">{fullDate(istDay(m.start_at))} to {fullDate(endDate)}</p></div>
        </div>
        <div className="p-5">
          <p className="eyebrow">Payment</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <div><p className="font-display text-2xl font-extrabold">{rupees(m.final_amount_cents)}</p><p className="text-xs text-fog">{m.discount_amount_cents > 0 ? `Includes ${rupees(m.discount_amount_cents)} of discounts on ${rupees(m.base_amount_cents)}` : 'Paid in full'}</p></div>
            <Badge tone="green">Paid and verified</Badge>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-washo-500 to-washo-300" style={{ width: `${m.washes_total ? (m.washes_completed / m.washes_total) * 100 : 0}%` }} /></div>
          <p className="mt-2 text-xs text-fog">{m.washes_completed} of {m.washes_total} washes done{m.washes_completed > 0 && tab !== 'completed' ? <> · <button type="button" onClick={() => setTab('completed')} className="font-semibold text-washo-300 hover:text-white">see them with photos</button></> : null}</p>
        </div>
      </div>

      <div className="mt-8">
        <Segmented label="Washes" value={tab} onChange={setTab} options={[{ value: 'upcoming', label: 'Upcoming', count: upcoming.length }, { value: 'completed', label: 'Completed', count: completed.length }, { value: 'other', label: 'Other', count: other.length }]} />
        {tab === 'completed'
          ? <p className="mt-3 flex items-center gap-2 text-xs text-fog"><Camera className="h-3.5 w-3.5" /> {completed.length ? 'Tap a wash to see what was done, with the before and after photos.' : 'Finished washes, with their photos, will appear here.'}</p>
          : <p className="mt-3 text-xs text-fog">Washes can be rescheduled but not cancelled. Need to pause? Contact WASHO.</p>}
        <ul className="mt-4 space-y-2.5">
          {list.map((w) => (
            <li key={w.id} className="panel flex flex-wrap items-center gap-3 p-4">
              {w.status === 'completed' ? (
                <button type="button" onClick={() => setViewing(w)} className="group flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`See the ${w.service_name} on ${prettyDate(w.scheduled_date)}, with photos`}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ok/15 text-ok"><Camera className="h-5 w-5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{prettyDate(w.scheduled_date)}</span>
                    <span className="block text-xs text-fog">{slotLabel(w.time_slot)} · {w.service_name} · see photos</span>
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0 text-fog transition-transform group-hover:translate-x-0.5" />
                </button>
              ) : (
                <Link to={`/app/bookings/${w.id}`} className="min-w-0 flex-1">
                  <p className="font-semibold">{prettyDate(w.scheduled_date)}</p>
                  <p className="text-xs text-fog">{slotLabel(w.time_slot)} · {w.service_name}</p>
                </Link>
              )}
              <CustomerStatus status={w.status} />
              {isLive(w.status) && w.occurrence_id && w.status !== 'in_progress' && m.status === 'active' && (
                <Button variant="glass" size="sm" icon={<CalendarClock className="h-4 w-4" />} onClick={() => setMoving(w)}>Reschedule</Button>
              )}
            </li>
          ))}
          {!list.length && <li className="panel p-5 text-center text-sm text-fog">Nothing here yet.</li>}
        </ul>
      </div>
      <RescheduleSheet wash={moving} endDate={endDate} onClose={() => setMoving(null)} />
      <WashDoneSheet wash={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
