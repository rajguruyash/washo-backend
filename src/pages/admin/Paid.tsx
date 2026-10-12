import { CalendarClock, ChevronDown, ChevronUp, Eye } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { patternLabel } from '../../components/WashBits';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { addDays, fullDate, istDay, prettyDate, prettyPhone, rupees, todayIST } from '../../lib/format';
import { monthlyDetail, planTitle } from '../../lib/plan';
import { useAdminBookings, useAdminMemberships } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { MOVABLE_STATUSES, payKind, payLabel, staffStatus } from '../../lib/status';
import type { AdminBooking, AdminMembership, BookingStatus } from '../../lib/types';
import { BookingSheet } from './BookingSheet';
import { Loading } from './shared';

/** Washes that are still to come, and the ones that are over (finished one way or another). */
const OPEN: BookingStatus[] = ['pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up'];
const OVER: BookingStatus[] = ['completed', 'cancelled', 'refund_requested', 'refunded', 'no_show'];
const SOURCE: Record<string, string> = { website: 'the website', mobile_app: 'the app', admin: 'WASHO', membership_schedule: 'a membership' };
const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** Every word typed must appear somewhere in the fields (any case; a mobile number matches however it was spaced). */
const matches = (search: string, ...fields: (string | null | undefined)[]) => {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  const flat = hay.replace(/[\s-]/g, '');
  return words.every((w) => hay.includes(w) || flat.includes(w.replace(/[\s-]/g, '')));
};

/**
 * The people who have PAID: memberships that are on, with every wash of each one (and a way to move a wash to another day), and the on-demand (single) washes:
 * what is coming up, what is happening now, and the history, each with everything about it and a way to move it. Paid by default (online, or cash taken by WASHO);
 * "All" adds the free, refunded and unpaid ones. The Washes tab has every wash.
 */
export default function Paid({ canManage }: { canManage: boolean }) {
  const [view, setView] = useState<'plans' | 'single'>('plans');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<{ id: string; startIn: 'details' | 'move' } | null>(null);
  const onOpen = (id: string, startIn: 'details' | 'move' = 'details') => setOpen({ id, startIn });
  return (
    <div className="space-y-4">
      <div className="glass grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <Input label="Search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, mobile number, vehicle, society, flat or reference" />
        <Segmented label="What to show" value={view} onChange={setView} options={[{ value: 'plans', label: 'Memberships on' }, { value: 'single', label: 'On-demand washes' }]} />
      </div>
      {view === 'plans' ? <Plans search={search} canManage={canManage} onOpen={onOpen} /> : <Singles search={search} canManage={canManage} onOpen={onOpen} />}
      <BookingSheet id={open?.id ?? null} startIn={open?.startIn} onClose={() => setOpen(null)} />
    </div>
  );
}

function Plans({ search, canManage, onOpen }: { search: string; canManage: boolean; onOpen: (id: string, startIn?: 'details' | 'move') => void }) {
  const { data, isLoading, isError, refetch } = useAdminMemberships();
  const [expanded, setExpanded] = useState<string | null>(null);
  const shown = useMemo(
    () =>
      (data ?? [])
        .filter((m) => m.status === 'active')
        .filter((m) => matches(search, m.customer_name, m.customer_phone, m.registration_number, m.vehicle_model, m.society_name, m.building_block, m.flat_number, m.reference_code, m.worker_name)),
    [data, search],
  );
  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading) return <Loading />;
  if (!shown.length) return <div className="panel p-8 text-center text-fog">{search ? 'No membership that is on matches.' : 'No membership is on right now.'}</div>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-fog">{shown.length} membership{shown.length === 1 ? '' : 's'} on, all paid.</p>
      {shown.map((m) => (
        <PlanCard key={m.id} m={m} open={expanded === m.id} onToggle={() => setExpanded(expanded === m.id ? null : m.id)} canManage={canManage} onOpen={onOpen} />
      ))}
    </div>
  );
}

function PlanCard({ m, open, onToggle, canManage, onOpen }: { m: AdminMembership; open: boolean; onToggle: () => void; canManage: boolean; onOpen: (id: string, startIn?: 'details' | 'move') => void }) {
  const where = [m.society_name, m.building_block, m.flat_number].filter(Boolean).join(', ');
  const paid = [rupees(m.final_amount_cents), m.payment_provider === 'razorpay' ? 'online' : m.payment_provider === 'offline' ? 'cash' : null, m.paid_at ? fullDate(istDay(m.paid_at)) : null].filter(Boolean).join(' · ');
  return (
    <div className="glass p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">{m.reference_code}</p>
          <p className="mt-1 text-lg font-bold">{planTitle(m, { short: true })}</p>
          <p className="mt-1 text-sm font-semibold">{m.customer_name} <a href={`tel:${m.customer_phone}`} className="font-normal text-washo-300">{m.customer_phone ? prettyPhone(m.customer_phone) : ''}</a></p>
        </div>
        <div className="flex flex-wrap items-center gap-2"><Badge tone="green">Paid · {paid}</Badge><Badge tone="blue">On</Badge></div>
      </div>
      <div className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <p className="text-mist">{m.vehicle_type?.toUpperCase()} · {m.vehicle_model} · {m.registration_number}</p>
        <p className="text-mist">{where || 'No address on file'}{m.parking_location ? ` · ${m.parking_location}` : ''}</p>
        {(m.monthly_body != null || m.weekly_pattern) && <p className="text-mist">{monthlyDetail(m, m.vehicle_type === 'bike') ?? patternLabel(m.weekly_pattern ?? [])}{m.time_slot ? ` · ${slotLabel(m.time_slot)}` : ''}</p>}
        <p className="text-mist">{fullDate(istDay(m.start_at))} to {fullDate(istDay(m.end_at))} · {m.washes_completed}/{m.washes_total} done{m.next_wash_date ? ` · next ${prettyDate(m.next_wash_date)}` : ''}</p>
        <p className="text-mist">Specialist: <span className="font-semibold text-white">{m.worker_name ?? <span className="text-warn">none yet</span>}</span></p>
        {m.customer_notes && <p className="text-fog">Note: {m.customer_notes}</p>}
      </div>
      <div className="mt-3"><Button size="sm" variant="glass" icon={open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />} onClick={onToggle}>{open ? 'Hide washes' : `Show all ${m.washes_total} washes`}</Button></div>
      {open && <PlanWashes membership={m.id} canManage={canManage} onOpen={onOpen} />}
    </div>
  );
}

function PlanWashes({ membership, canManage, onOpen }: { membership: string; canManage: boolean; onOpen: (id: string, startIn?: 'details' | 'move') => void }) {
  const { data, isLoading, isError, refetch } = useAdminBookings({ membership });
  if (isError) return <div className="mt-3"><ErrorState onRetry={() => void refetch()} /></div>;
  if (isLoading) return <div className="mt-3"><Loading /></div>;
  if (!data?.length) return <p className="mt-3 text-sm text-fog">No washes yet.</p>;
  return (
    <ul className="mt-3 space-y-2">
      {data.map((b) => (
        <li key={b.id} className={`panel flex flex-wrap items-center gap-x-4 gap-y-2 p-3 ${b.status === 'cancelled' ? 'opacity-60' : ''}`}>
          <button type="button" onClick={() => onOpen(b.id)} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-left" aria-label={`Open wash on ${prettyDate(b.scheduled_date)}`}>
            <span className="w-32 shrink-0"><span className="block text-sm font-bold">{prettyDate(b.scheduled_date)}</span><span className="block text-xs text-fog">{slotLabel(b.time_slot)}</span></span>
            <span className="min-w-0 flex-1 truncate text-sm">{b.service_name}</span>
            <span className="w-32 truncate text-sm text-mist">{b.worker_name ?? <span className="text-warn">Unassigned</span>}</span>
            <Badge tone={staffStatus[b.status].tone}>{staffStatus[b.status].label}</Badge>
          </button>
          {canManage && MOVABLE_STATUSES.includes(b.status) && <Button size="sm" variant="glass" icon={<CalendarClock className="h-4 w-4" />} onClick={() => onOpen(b.id, 'move')}>Reschedule</Button>}
        </li>
      ))}
    </ul>
  );
}

type Phase = 'upcoming' | 'live' | 'history';

function Singles({ search, canManage, onOpen }: { search: string; canManage: boolean; onOpen: (id: string, startIn?: 'details' | 'move') => void }) {
  const today = todayIST();
  const [phase, setPhase] = useState<Phase>('upcoming');
  const [paid, setPaid] = useState<'paid' | 'all'>('paid');
  const [from, setFrom] = useState(addDays(today, -90));
  const [to, setTo] = useState(addDays(today, 30));
  const pay = paid === 'paid' ? 'paid' : undefined;
  // Upcoming and live come from one list (a wash that started and was never finished is still live days later); history has its own dates and is newest first.
  const ahead = useAdminBookings({ type: 'on_demand', pay, from: addDays(today, -14), to: addDays(today, 90) });
  const past = useAdminBookings({ type: 'on_demand', pay, from, to, order: 'desc' });
  const source = phase === 'history' ? past : ahead;
  const shown = useMemo(() => {
    const rows = (source.data ?? []).filter((b) => matches(search, b.customer_name, b.customer_phone, b.registration_number, b.vehicle_model, b.society_name, b.building_block, b.flat_number, b.reference_code, b.worker_name, b.service_name));
    if (phase === 'live') return rows.filter((b) => b.status === 'in_progress');
    if (phase === 'upcoming') return rows.filter((b) => OPEN.includes(b.status));
    return rows.filter((b) => OVER.includes(b.status));
  }, [source.data, phase, search]);
  const counts = useMemo(() => {
    const rows = ahead.data ?? [];
    return { upcoming: rows.filter((b) => OPEN.includes(b.status)).length, live: rows.filter((b) => b.status === 'in_progress').length };
  }, [ahead.data]);
  const collected = phase === 'history' ? shown.filter((b) => b.status === 'completed' && b.payment_kind === 'paid').reduce((n, b) => n + (b.price_cents ?? 0), 0) : 0;
  const done = phase === 'history' ? shown.filter((b) => b.status === 'completed').length : 0;
  const n = shown.length;
  const count = `${n} ${phase === 'upcoming' ? 'upcoming ' : ''}wash${n === 1 ? '' : 'es'}${phase === 'live' ? ' in progress' : ''}`;
  return (
    <div className="space-y-3">
      <div className="glass grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <Segmented label="When" value={phase} onChange={setPhase} options={[{ value: 'upcoming', label: `Upcoming${counts.upcoming ? ` (${counts.upcoming})` : ''}` }, { value: 'live', label: `Live${counts.live ? ` (${counts.live})` : ''}` }, { value: 'history', label: 'History' }]} />
        <Segmented label="Payment" value={paid} onChange={setPaid} options={[{ value: 'paid', label: 'Paid' }, { value: 'all', label: 'All' }]} />
        {phase === 'history' && (
          <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
            <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
      </div>
      {source.isError ? <ErrorState onRetry={() => void source.refetch()} /> : source.isLoading ? <Loading /> : !shown.length ? (
        <div className="panel p-8 text-center text-fog">
          {search ? `No ${paid === 'paid' ? 'paid ' : ''}on-demand wash matches.` : phase === 'live' ? 'No wash is in progress right now.' : phase === 'upcoming' ? `No upcoming ${paid === 'paid' ? 'paid ' : ''}on-demand washes.` : `No ${paid === 'paid' ? 'paid ' : ''}on-demand washes in these dates.`}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-fog">
            {count}{phase === 'history' ? ` · ${done} completed${collected ? ` · ${rupees(collected)} collected` : ''}` : ''}.
          </p>
          {shown.map((b) => <SingleCard key={b.id} b={b} canManage={canManage} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  );
}

/** One on-demand wash with everything about it. Photos and the full timeline are in its page ("Details"). */
function SingleCard({ b, canManage, onOpen }: { b: AdminBooking; canManage: boolean; onOpen: (id: string, startIn?: 'details' | 'move') => void }) {
  const where = [b.society_name, b.building_block, b.flat_number].filter(Boolean).join(', ');
  const overdue = OPEN.includes(b.status) && b.scheduled_date < todayIST();
  const price = b.price_cents != null ? (b.price_cents === 0 ? 'Free' : rupees(b.price_cents)) : null;
  const how = b.payment_kind === 'paid' ? [price, b.payment_provider === 'razorpay' ? 'online' : b.payment_provider === 'offline' ? 'cash' : null, b.paid_at ? `paid ${fullDate(istDay(b.paid_at))}` : null] : [price];
  return (
    <div className={`glass p-5 ${b.status === 'cancelled' ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">{b.reference_code}</p>
          <p className="mt-1 text-lg font-bold">{prettyDate(b.scheduled_date)} <span className="text-base font-semibold text-fog">· {slotLabel(b.time_slot)}</span></p>
          <p className="mt-0.5 text-sm font-semibold">{b.service_name}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {overdue && <Badge tone="red">Overdue</Badge>}
          {b.campaign_name && <Badge tone="yellow">{b.campaign_name}</Badge>}
          <Badge tone={payKind[b.payment_kind]?.tone ?? 'slate'}>{b.payment_kind ? payLabel(b.payment_kind, b.payment_provider) : 'Paid'}</Badge>
          <Badge tone={staffStatus[b.status].tone}>{staffStatus[b.status].label}</Badge>
        </div>
      </div>
      <div className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <p className="text-mist"><span className="font-semibold text-white">{b.customer_name ?? 'Customer'}</span> <a href={`tel:${b.customer_phone}`} className="text-washo-300">{b.customer_phone ? prettyPhone(b.customer_phone) : ''}</a></p>
        <p className="text-mist">{b.vehicle_type?.toUpperCase()} · {b.vehicle_model} · {b.registration_number}{b.vehicle_color ? ` · ${b.vehicle_color}` : ''}</p>
        <p className="text-mist">{where || 'No address on file'}{b.parking_location ? ` · ${b.parking_location}` : ''}</p>
        <p className="text-mist">Specialist: <span className="font-semibold text-white">{b.worker_name ?? <span className="text-warn">none yet</span>}</span>{b.customer_confirmed_at && OPEN.includes(b.status) ? ' · customer confirmed by phone' : ''}</p>
        <p className="text-mist">Payment: {how.filter(Boolean).join(' · ') || payLabel(b.payment_kind, b.payment_provider)}</p>
        <p className="text-mist">Booked {b.booked_at ? when(b.booked_at) : ''}{b.source && SOURCE[b.source] ? ` through ${SOURCE[b.source]}` : ''}</p>
        {b.completed_at && <p className="text-mist">Completed {when(b.completed_at)}</p>}
        {b.cancel_reason && <p className="text-fog">Cancelled: {b.cancel_reason}</p>}
        {b.notes && <p className="text-fog sm:col-span-2">Note: {b.notes}</p>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="glass" icon={<Eye className="h-4 w-4" />} onClick={() => onOpen(b.id)}>Details, photos and timeline</Button>
        {canManage && MOVABLE_STATUSES.includes(b.status) && <Button size="sm" variant="glass" icon={<CalendarClock className="h-4 w-4" />} onClick={() => onOpen(b.id, 'move')}>Reschedule</Button>}
      </div>
    </div>
  );
}
