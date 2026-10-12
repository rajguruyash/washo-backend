import { CalendarClock, ChevronDown, ChevronUp } from 'lucide-react';
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
import { payKind, payLabel, staffStatus } from '../../lib/status';
import type { AdminBooking, AdminMembership } from '../../lib/types';
import { BookingSheet } from './BookingSheet';
import { Loading } from './shared';

/** A wash that can still be moved (the same states the wash page allows). */
const MOVABLE = ['confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up'];

/** Every word typed must appear somewhere in the fields (any case; a mobile number matches however it was spaced). */
const matches = (search: string, ...fields: (string | null | undefined)[]) => {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  const flat = hay.replace(/[\s-]/g, '');
  return words.every((w) => hay.includes(w) || flat.includes(w.replace(/[\s-]/g, '')));
};

/**
 * The people who have PAID: memberships that are on, with every wash of each one (and a way to move a wash to another day), and the single washes that were
 * paid for (online, or cash taken by WASHO). Free washes are not here; the Washes tab has everything.
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
        <Segmented label="What to show" value={view} onChange={setView} options={[{ value: 'plans', label: 'Memberships on' }, { value: 'single', label: 'Paid single washes' }]} />
      </div>
      {view === 'plans' ? <Plans search={search} canManage={canManage} onOpen={onOpen} /> : <Singles search={search} onOpen={onOpen} />}
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
          {canManage && MOVABLE.includes(b.status) && <Button size="sm" variant="glass" icon={<CalendarClock className="h-4 w-4" />} onClick={() => onOpen(b.id, 'move')}>Reschedule</Button>}
        </li>
      ))}
    </ul>
  );
}

function Singles({ search, onOpen }: { search: string; onOpen: (id: string, startIn?: 'details' | 'move') => void }) {
  const [from, setFrom] = useState(todayIST());
  const [to, setTo] = useState(addDays(todayIST(), 30));
  const { data, isLoading, isError, refetch } = useAdminBookings({ from, to, pay: 'paid' });
  const shown = useMemo(
    () => (data ?? []).filter((b) => matches(search, b.customer_name, b.customer_phone, b.registration_number, b.vehicle_model, b.society_name, b.building_block, b.flat_number, b.reference_code, b.worker_name, b.service_name)),
    [data, search],
  );
  return (
    <div className="space-y-3">
      <div className="glass grid gap-3 p-4 sm:grid-cols-2">
        <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {isError ? <ErrorState onRetry={() => void refetch()} /> : isLoading ? <Loading /> : !shown.length ? <div className="panel p-8 text-center text-fog">No paid single washes in these dates{search ? ' match' : ''}.</div> : (
        <div className="space-y-2">
          <p className="text-sm text-fog">{shown.length} paid single wash{shown.length === 1 ? '' : 'es'}.</p>
          {shown.map((b: AdminBooking) => (
            <button key={b.id} onClick={() => onOpen(b.id)} className="glass flex w-full flex-wrap items-center gap-x-5 gap-y-2 p-4 text-left transition-colors hover:border-washo-400/40">
              <div className="w-28 shrink-0"><p className="text-sm font-bold">{prettyDate(b.scheduled_date)}</p><p className="text-xs text-fog">{slotLabel(b.time_slot)}</p></div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{b.service_name} · {b.registration_number}</p>
                <p className="truncate text-xs text-fog">{b.customer_name} · {b.customer_phone ? prettyPhone(b.customer_phone) : ''} · {[b.society_name, b.building_block, b.flat_number].filter(Boolean).join(', ')}</p>
              </div>
              <p className="w-32 truncate text-sm text-mist">{b.worker_name ?? <span className="text-warn">Unassigned</span>}</p>
              {b.price_cents != null && <p className="w-16 text-right text-sm tabular-nums text-mist">{rupees(b.price_cents)}</p>}
              <Badge tone={payKind[b.payment_kind]?.tone ?? 'slate'}>{b.payment_kind ? payLabel(b.payment_kind, b.payment_provider) : 'Paid'}</Badge>
              <Badge tone={staffStatus[b.status].tone}>{staffStatus[b.status].label}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
