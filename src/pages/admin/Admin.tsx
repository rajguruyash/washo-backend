import { AlertTriangle, CalendarClock, Check, Phone, Search, UserPlus, Users, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DateSlotPicker } from '../../components/DateSlotPicker';
import { ErrorState } from '../../components/EmptyState';
import { PhotoGrid } from '../../components/PhotoGrid';
import { QuoteBreakdownView } from '../../components/Quote';
import { patternLabel } from '../../components/WashBits';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select, TextArea } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet } from '../../components/ui/Sheet';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { addDays, fullDate, prettyDate, prettyPhone, rupees, todayIST } from '../../lib/format';
import { ApiError, get, post } from '../../lib/http';
import {
  keys, useAdminAction, useAdminAttention, useAdminBooking, useAdminBookings, useAdminMemberships, useAdminOverview, useAdminRequests, useAdminWorkers, useReviewRequest, useRefreshAll,
} from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { staffStatus } from '../../lib/status';
import type { AdminBooking, AdminMembership, AdminRequest, Attention as AttentionData, RequestStatus, SlotId } from '../../lib/types';
import { StaffLayout } from '../../layouts/StaffLayout';

type Tab = 'overview' | 'requests' | 'bookings' | 'memberships' | 'people' | 'attention';
const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'requests', label: 'Requests' },
  { value: 'bookings', label: 'Washes' },
  { value: 'memberships', label: 'Memberships' },
  { value: 'people', label: 'People' },
  { value: 'attention', label: 'Needs attention' },
];

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
const Loading = () => <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>;

// ───────────────────────── overview ─────────────────────────
function Overview({ go }: { go: (t: Tab) => void }) {
  const { data: o, isLoading, isError, refetch } = useAdminOverview();
  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !o) return <Loading />;
  const tile = (label: string, value: number, tab: Tab, hot = false) => (
    <button key={label} onClick={() => go(tab)} className={`glass p-5 text-left transition-colors hover:border-washo-400/40 ${hot && value > 0 ? 'border-warn/40' : ''}`}>
      <p className={`font-display text-4xl font-extrabold tabular-nums ${hot && value > 0 ? 'text-warn' : ''}`}>{value}</p>
      <p className="mt-1 text-sm text-fog">{label}</p>
    </button>
  );
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
      {tile('Requests to quote', o.requests_to_quote, 'requests', true)}
      {tile('Quotes awaiting customer', o.quotes_awaiting_customer, 'requests')}
      {tile('Washes today', o.washes_today, 'bookings')}
      {tile('Done today', o.washes_done_today, 'bookings')}
      {tile('Unassigned, next 3 days', o.unassigned_next_3_days, 'bookings', true)}
      {tile('Worker issues, 24h', o.issues_24h, 'bookings', true)}
      {tile('Active memberships', o.active_memberships, 'memberships')}
      {tile('Payments / refunds to resolve', o.unfulfilled_payments + o.refunds_requested, 'attention', true)}
    </div>
  );
}

// ───────────────────────── requests ─────────────────────────
function ReviewSheet({ req, onClose }: { req: AdminRequest | null; onClose: () => void }) {
  const review = useReviewRequest();
  const toast = useToast();
  const [mode, setMode] = useState<'quote' | 'reject'>('quote');
  const [adj, setAdj] = useState('');
  const [reason, setReason] = useState('');
  const [rejection, setRejection] = useState('');
  useEffect(() => { setMode('quote'); setAdj(''); setReason(''); setRejection(''); }, [req]);
  if (!req) return <Sheet open={false} onClose={onClose} children={null} />;
  const q = req.system_quote;
  const adjCents = Math.round((parseFloat(adj) || 0) * 100);
  const final = q ? q.final_cents + adjCents : 0;

  const submit = async () => {
    try {
      await review.mutateAsync(mode === 'quote'
        ? { id: req.id, action: 'quote', adjustment_cents: adjCents, adjustment_reason: reason }
        : { id: req.id, action: 'reject', rejection_reason: rejection });
      toast.success(mode === 'quote' ? 'Quote sent to the customer' : 'Request rejected');
      onClose();
    } catch (e) { toast.error(errText(e)); }
  };

  return (
    <Sheet open onClose={onClose} size="lg" title={`${req.reference_code} · ${mode === 'quote' ? 'Set the price' : 'Reject'}`}
      description={`${req.customer.name ?? 'Customer'} · ${prettyPhone(req.customer.phone)}`}
      footer={<Button full size="lg" variant={mode === 'reject' ? 'danger' : 'primary'} loading={review.isPending} disabled={mode === 'reject' ? rejection.trim().length < 3 : adjCents !== 0 && reason.trim().length < 5} onClick={() => void submit()}>{mode === 'quote' ? `Send quote ${q ? rupees(final) : ''}` : 'Reject request'}</Button>}>
      <div className="space-y-5">
        <Segmented label="Decision" value={mode} onChange={setMode} options={[{ value: 'quote', label: 'Quote' }, { value: 'reject', label: 'Reject' }]} />
        {q && mode === 'quote' && (
          <>
            <p className="text-sm text-fog">The rate card produced this. The customer sees every line, so an adjustment needs a reason they can read.</p>
            <QuoteBreakdownView q={{ ...q, adjustment: { cents: adjCents, reason: reason || null }, final_cents: final }} />
            <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
              <Input label="Adjustment (₹)" inputMode="decimal" placeholder="-500 or 200" value={adj} onChange={(e) => setAdj(e.target.value.replace(/[^0-9.\-]/g, ''))} optional hint="Negative lowers the price." />
              <Input label="Reason the customer will see" value={reason} onChange={(e) => setReason(e.target.value)} optional={adjCents === 0} maxLength={200} />
            </div>
          </>
        )}
        {mode === 'reject' && <TextArea label="Reason shown to the customer" value={rejection} onChange={(e) => setRejection(e.target.value)} maxLength={300} placeholder="We don't serve that block yet." />}
      </div>
    </Sheet>
  );
}

function Requests() {
  const [status, setStatus] = useState<'submitted' | 'quoted' | 'all'>('submitted');
  const { data, isLoading, isError, refetch } = useAdminRequests(status === 'all' ? undefined : (status as RequestStatus));
  const [open, setOpen] = useState<AdminRequest | null>(null);
  return (
    <div className="space-y-4">
      <Segmented label="Request status" value={status} onChange={setStatus} options={[{ value: 'submitted', label: 'To quote' }, { value: 'quoted', label: 'Quoted' }, { value: 'all', label: 'All' }]} />
      {isError ? <ErrorState onRetry={() => void refetch()} /> : isLoading ? <Loading /> : !data?.length ? <div className="panel p-8 text-center text-fog">No requests here.</div> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((r) => (
            <div key={r.id} className="glass p-5">
              <div className="flex items-start justify-between gap-3">
                <div><p className="eyebrow">{r.reference_code}</p><p className="mt-1 text-lg font-bold">{r.frequency_per_week} a week · {r.duration_months} mo</p></div>
                <Badge tone={r.status === 'submitted' ? 'amber' : r.status === 'quoted' ? 'blue' : r.status === 'active' ? 'green' : 'slate'}>{r.status}</Badge>
              </div>
              <p className="mt-2 text-sm font-semibold">{r.customer.name} <a href={`tel:${r.customer.phone}`} className="font-normal text-washo-300">{prettyPhone(r.customer.phone)}</a></p>
              <p className="mt-1 text-sm text-fog">{r.vehicle.type.toUpperCase()} · {r.vehicle.model} · {r.vehicle.registration_number}</p>
              <p className="mt-1 text-sm text-mist">{patternLabel(r.weekly_pattern)} · {slotLabel(r.time_slot)}</p>
              <p className="text-xs text-fog">Start {fullDate(r.start_date)}{r.address ? ` · ${r.address.society}, ${r.address.block} ${r.address.flat}` : ''}</p>
              {r.customer_notes && <p className="mt-2 rounded-xl bg-white/[0.04] p-3 text-sm text-mist">“{r.customer_notes}”</p>}
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-sm text-fog">{r.quoted_amount_cents ? <>Quoted <span className="font-bold text-white">{rupees(r.quoted_amount_cents)}</span></> : r.system_quote ? <>Rate card <span className="font-bold text-white">{rupees(r.system_quote.final_cents)}</span></> : ''}</p>
                {(r.status === 'submitted' || r.status === 'quoted') && <Button size="sm" onClick={() => setOpen(r)}>{r.status === 'quoted' ? 'Re-quote' : 'Review'}</Button>}
              </div>
            </div>
          ))}
        </div>
      )}
      <ReviewSheet req={open} onClose={() => setOpen(null)} />
    </div>
  );
}

// ───────────────────────── bookings ─────────────────────────
function BookingSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data } = useAdminBooking(id ?? undefined);
  const workers = useAdminWorkers();
  const act = useAdminAction();
  const toast = useToast();
  const [view, setView] = useState<'details' | 'move' | 'cancel'>('details');
  const [worker, setWorker] = useState('');
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<SlotId | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { setView('details'); setWorker(''); setDate(null); setSlot(null); setReason(''); }, [id]);
  const b = data?.booking;
  const run = async (path: string, body: Record<string, unknown>, ok: string) => {
    try { await act.mutateAsync({ path, body }); toast.success(ok); setView('details'); } catch (e) { toast.error(errText(e)); }
  };
  const live = b && ['confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up'].includes(b.status);

  return (
    <Sheet open={Boolean(id)} onClose={onClose} size="lg" title={b ? `${b.reference_code} · ${b.service_name}` : 'Wash'} description={b ? `${prettyDate(b.scheduled_date)}, ${slotLabel(b.time_slot)}` : undefined}>
      {!b ? <Loading /> : view === 'details' ? (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2"><Badge tone={staffStatus[b.status].tone}>{staffStatus[b.status].label}</Badge>{b.booking_type === 'membership' && <Badge tone="blue">Membership</Badge>}{b.customer_confirmed_at && <Badge tone="green">Customer confirmed</Badge>}</div>
          <div className="grid gap-4 text-sm sm:grid-cols-2">
            <div><p className="eyebrow">Customer</p><p className="font-semibold">{b.customer_name}</p><a href={`tel:${b.customer_phone}`} className="text-washo-300">{prettyPhone(b.customer_phone)}</a></div>
            <div><p className="eyebrow">Vehicle</p><p>{b.vehicle_type.toUpperCase()} · {b.vehicle_model} {b.vehicle_color ?? ''}</p><p className="text-fog">{b.registration_number}</p></div>
            <div><p className="eyebrow">Address</p><p>{[b.society_name, b.building_block, b.flat_number].filter(Boolean).join(', ')}</p><p className="text-fog">{b.parking_location}</p></div>
            <div><p className="eyebrow">Specialist</p><p className="font-semibold">{b.worker_name ?? 'Unassigned'}</p></div>
          </div>
          {live && (
            <div className="space-y-3 rounded-2xl border border-white/10 p-4">
              <Select label="Assign specialist" value={worker} onChange={(e) => setWorker(e.target.value)}>
                <option value="">Choose…</option>
                {workers.data?.map((w) => <option key={w.id} value={w.id}>{w.full_name} · {w.washes_next_7_days} washes this week</option>)}
              </Select>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!worker} loading={act.isPending} onClick={() => void run(`bookings/${b.id}/assign`, { worker_profile_id: worker }, 'Assigned')}>Assign</Button>
                {b.booking_type === 'membership' && <Button size="sm" variant="glass" icon={<CalendarClock className="h-4 w-4" />} onClick={() => setView('move')}>Reschedule</Button>}
                <Button size="sm" variant="danger" icon={<XCircle className="h-4 w-4" />} onClick={() => setView('cancel')}>Cancel wash</Button>
              </div>
            </div>
          )}
          <section><h3 className="mb-2 text-sm font-bold">Photos</h3><PhotoGrid bookingId={b.id} /></section>
          <section>
            <h3 className="mb-2 text-sm font-bold">History</h3>
            <ol className="space-y-2 text-sm">
              {data!.events.map((e, i) => (
                <li key={i} className="panel p-3">
                  <p className="font-semibold">{e.event_type.replace(/_/g, ' ')}{e.actor_name ? <span className="font-normal text-fog"> · {e.actor_name} ({e.actor_role})</span> : null}</p>
                  <p className="text-xs text-fog">{new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(e.created_at))}</p>
                  {(e.meta.notes || e.meta.note || e.meta.reason || e.meta.kind) && <p className="mt-1 text-mist">{[e.meta.kind, e.meta.notes, e.meta.note, e.meta.reason].filter(Boolean).join(' · ')}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : view === 'move' ? (
        <div className="space-y-5">
          <DateSlotPicker date={date} slot={slot} onDate={setDate} onSlot={setSlot} min={todayIST()} days={45} />
          <Input label="Reason" optional value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          <div className="grid grid-cols-2 gap-3"><Button variant="glass" onClick={() => setView('details')}>Back</Button><Button disabled={!date || !slot} loading={act.isPending} onClick={() => void run(`bookings/${b.id}/reschedule`, { date, time_slot: slot, reason }, 'Rescheduled')}>Move wash</Button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <TextArea label="Reason (the customer and specialist will see it)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          <p className="text-xs text-fog">Cancelling a paid on-demand wash raises a refund request. For a membership wash, consider rescheduling instead.</p>
          <div className="grid grid-cols-2 gap-3"><Button variant="glass" onClick={() => setView('details')}>Back</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={act.isPending} onClick={() => void run(`bookings/${b.id}/cancel`, { reason }, 'Cancelled')}>Cancel wash</Button></div>
        </div>
      )}
    </Sheet>
  );
}

function Bookings({ membership }: { membership?: string }) {
  const [from, setFrom] = useState(todayIST());
  const [to, setTo] = useState(addDays(todayIST(), 7));
  const [status, setStatus] = useState('');
  const [unassigned, setUnassigned] = useState(false);
  const filter = useMemo(() => (membership ? { membership } : { from, to, status: status || undefined, unassigned }), [membership, from, to, status, unassigned]);
  const { data, isLoading, isError, refetch } = useAdminBookings(filter);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {!membership && (
        <div className="glass grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
          <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {Object.entries(staffStatus).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
          <label className="flex h-12 items-center gap-2 text-sm"><input type="checkbox" checked={unassigned} onChange={(e) => setUnassigned(e.target.checked)} className="h-4 w-4" /> Unassigned only</label>
        </div>
      )}
      {isError ? <ErrorState onRetry={() => void refetch()} /> : isLoading ? <Loading /> : !data?.length ? <div className="panel p-8 text-center text-fog">No washes match.</div> : (
        <div className="space-y-2">
          {data.map((b: AdminBooking) => (
            <button key={b.id} onClick={() => setOpen(b.id)} className="glass flex w-full flex-wrap items-center gap-x-5 gap-y-2 p-4 text-left transition-colors hover:border-washo-400/40">
              <div className="w-28 shrink-0"><p className="text-sm font-bold">{prettyDate(b.scheduled_date)}</p><p className="text-xs text-fog">{slotLabel(b.time_slot)}</p></div>
              <div className="min-w-0 flex-1"><p className="truncate font-semibold">{b.service_name} · {b.registration_number}</p><p className="truncate text-xs text-fog">{b.customer_name} · {[b.society_name, b.flat_number].filter(Boolean).join(', ')}</p></div>
              <p className="w-32 truncate text-sm text-mist">{b.worker_name ?? <span className="text-warn">Unassigned</span>}</p>
              <Badge tone={staffStatus[b.status].tone}>{staffStatus[b.status].label}</Badge>
            </button>
          ))}
        </div>
      )}
      <BookingSheet id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

// ───────────────────────── memberships ─────────────────────────
function Memberships({ showWashes }: { showWashes: (id: string) => void }) {
  const { data, isLoading, isError, refetch } = useAdminMemberships();
  const workers = useAdminWorkers();
  const act = useAdminAction();
  const toast = useToast();
  const [open, setOpen] = useState<AdminMembership | null>(null);
  const [worker, setWorker] = useState('');
  useEffect(() => setWorker(open?.worker_id ?? ''), [open]);
  const assign = async () => {
    if (!open) return;
    try { await act.mutateAsync({ path: `memberships/${open.id}/assign-worker`, body: { worker_profile_id: worker || null } }); toast.success(worker ? 'Specialist assigned to every remaining wash' : 'Washes released to the pool'); setOpen(null); } catch (e) { toast.error(errText(e)); }
  };
  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.map((m) => (
          <div key={m.id} className="glass p-5">
            <div className="flex items-start justify-between gap-3"><div><p className="eyebrow">{m.reference_code}</p><p className="mt-1 text-lg font-bold">{m.frequency_per_week} a week · {m.duration_months} mo · {rupees(m.final_amount_cents)}</p></div><Badge tone={m.status === 'active' ? 'green' : 'slate'}>{m.status}</Badge></div>
            <p className="mt-2 text-sm font-semibold">{m.customer_name} <span className="font-normal text-fog">{prettyPhone(m.customer_phone)}</span></p>
            <p className="text-sm text-fog">{m.vehicle_type?.toUpperCase()} · {m.vehicle_model} · {m.registration_number}</p>
            {m.weekly_pattern && <p className="mt-1 text-sm text-mist">{patternLabel(m.weekly_pattern)}{m.time_slot ? ` · ${slotLabel(m.time_slot)}` : ''}</p>}
            <p className="mt-1 text-xs text-fog">{m.washes_completed}/{m.washes_total} done · {fullDate(m.start_at.slice(0, 10))} to {fullDate(m.end_at.slice(0, 10))}{m.next_wash_date ? ` · next ${prettyDate(m.next_wash_date)}` : ''}</p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">Specialist: <span className="font-semibold">{m.worker_name ?? <span className="text-warn">none</span>}</span></p>
              <div className="flex gap-2"><Button size="sm" variant="glass" onClick={() => showWashes(m.id)}>Washes</Button>{m.status === 'active' && <Button size="sm" onClick={() => setOpen(m)}>Assign</Button>}</div>
            </div>
          </div>
        ))}
        {!data?.length && <div className="panel p-8 text-center text-fog lg:col-span-2">No memberships yet.</div>}
      </div>
      <Sheet open={Boolean(open)} onClose={() => setOpen(null)} size="sm" title="Regular specialist" description="They get every remaining wash of this membership. Washes the customer moves return to them." footer={<Button full size="lg" loading={act.isPending} onClick={() => void assign()}>{worker ? 'Assign' : 'Release to pool'}</Button>}>
        <Select label="Specialist" value={worker} onChange={(e) => setWorker(e.target.value)}>
          <option value="">Nobody (release to the pool)</option>
          {workers.data?.map((w) => <option key={w.id} value={w.id}>{w.full_name} · {w.washes_next_7_days} this week</option>)}
        </Select>
      </Sheet>
    </>
  );
}

// ───────────────────────── customers & specialists ─────────────────────────
function People() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(t); }, [q]);
  const customers = useQuery({ queryKey: keys.admin('customers', debounced), queryFn: async () => (await get<{ customers: { id: string; full_name: string | null; phone: string | null; email: string | null; signup_source: string | null; vehicles: number; active_memberships: number; washes: number }[] }>(`/admin/customers?q=${encodeURIComponent(debounced)}`)).customers });
  const workers = useAdminWorkers();
  const refresh = useRefreshAll();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ full_name: '', email: '', phone: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await post('/admin/workers', f);
      await refresh();
      toast.success('Specialist created. Share their email and password with them.');
      setAdding(false);
      setF({ full_name: '', email: '', phone: '', password: '' });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields); else toast.error(errText(err));
    } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section>
        <div className="mb-3 flex items-center justify-between"><h2 className="flex items-center gap-2 text-lg font-bold"><Users className="h-5 w-5 text-washo-300" /> Specialists</h2><Button size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add</Button></div>
        <ul className="space-y-2">
          {workers.data?.map((w) => (
            <li key={w.id} className="panel flex items-center justify-between gap-3 p-4"><div><p className="font-semibold">{w.full_name}</p><a href={`tel:${w.phone}`} className="text-sm text-washo-300">{w.phone}</a></div><Badge tone="blue">{w.washes_next_7_days} this week</Badge></li>
          ))}
          {workers.data && !workers.data.length && <li className="panel p-6 text-center text-sm text-fog">No specialists yet.</li>}
        </ul>
      </section>
      <section>
        <h2 className="mb-3 text-lg font-bold">Customers</h2>
        <div className="relative mb-3"><Search className="pointer-events-none absolute left-4 top-3.5 h-4 w-4 text-fog" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone" aria-label="Search customers" className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] pl-11 pr-4 outline-none focus:border-washo-400" /></div>
        <ul className="space-y-2">
          {customers.data?.map((c) => (
            <li key={c.id} className="panel p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{c.full_name ?? 'No name yet'}</p><p className="text-sm text-fog"><Phone className="mr-1 inline h-3 w-3" />{prettyPhone(c.phone)}{c.email ? ` · ${c.email}` : ''}</p></div>{c.active_memberships > 0 && <Badge tone="green">Member</Badge>}</div><p className="mt-1 text-xs text-fog">{c.vehicles} vehicle{c.vehicles === 1 ? '' : 's'} · {c.washes} washes{c.signup_source ? ` · via ${c.signup_source}` : ''}</p></li>
          ))}
          {customers.data && !customers.data.length && <li className="panel p-6 text-center text-sm text-fog">No customers found.</li>}
        </ul>
      </section>
      <Sheet open={adding} onClose={() => setAdding(false)} size="sm" title="Add a specialist" description="They sign in at /login with this email and password." footer={<Button type="submit" form="worker-form" full size="lg" loading={busy}>Create specialist</Button>}>
        <form id="worker-form" onSubmit={create} className="space-y-4" noValidate>
          <Input label="Full name" value={f.full_name} error={errors.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} required />
          <Input label="Email" type="email" value={f.email} error={errors.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          <Input label="Phone" value={f.phone} error={errors.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required />
          <Input label="Temporary password" type="text" value={f.password} error={errors.password} onChange={(e) => setF({ ...f, password: e.target.value })} hint="At least 8 characters." required />
        </form>
      </Sheet>
    </div>
  );
}

// ───────────────────────── needs attention ─────────────────────────
function Attention() {
  const { data, isLoading, isError, refetch } = useAdminAttention();
  const act = useAdminAction();
  const refresh = useRefreshAll();
  const toast = useToast();
  const [approving, setApproving] = useState<AttentionData['refunds'][number] | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [rid, setRid] = useState('');
  const approve = async () => {
    if (!approving) return;
    try {
      await act.mutateAsync({ path: `refunds/${approving.id}/approve` });
      toast.success(`${rupees(approving.amount_cents)} refunded through Razorpay`);
    } catch (e) {
      toast.error(errText(e));
      void refresh(); // the refund may now show as failed, with Razorpay's reason
    }
    setApproving(null);
  };
  const resolve = async (status: 'approved' | 'processed' | 'failed') => {
    try { await act.mutateAsync({ path: `refunds/${resolving}/resolve`, body: { status, provider_refund_id: rid || undefined } }); toast.success('Refund updated'); setResolving(null); setRid(''); } catch (e) { toast.error(errText(e)); }
  };
  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !data) return <Loading />;
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-bold"><AlertTriangle className="h-5 w-5 text-warn" /> Paid but not fulfilled</h2>
        {data.unfulfilled.length ? <ul className="space-y-2">{data.unfulfilled.map((p) => <li key={p.id} className="panel p-4 text-sm"><p className="font-semibold">{rupees(p.amount_cents)} · {p.payment_kind} · {p.customer_name} {prettyPhone(p.customer_phone)}</p><p className="text-xs text-fog">Razorpay payment {p.provider_payment_id}. A refund request was created automatically.</p></li>)}</ul> : <p className="panel p-5 text-sm text-fog">Nothing. Every verified payment became a booking or membership.</p>}
      </section>
      <section>
        <h2 className="mb-1 text-lg font-bold">Refund requests</h2>
        <p className="mb-3 text-sm text-fog">Nothing is refunded until you approve it. Approving sends the full amount back to the customer through Razorpay.</p>
        {data.refunds.length ? <ul className="space-y-2">{data.refunds.map((r) => (
          <li key={r.id} className="panel flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="text-sm">
              <p className="font-semibold">{rupees(r.amount_cents)} · {r.customer_name} {prettyPhone(r.customer_phone)}</p>
              <p className="text-xs text-fog">{r.reason} · {r.status}</p>
              {r.status === 'failed' && r.failure_reason && <p className="mt-1 text-xs text-warn">Razorpay said: {r.failure_reason}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setResolving(r.id)}>Paid it by hand</Button>
              <Button size="sm" onClick={() => setApproving(r)}>{r.status === 'failed' ? 'Try again' : 'Approve and refund'}</Button>
            </div>
          </li>
        ))}</ul> : <p className="panel p-5 text-sm text-fog">No open refunds.</p>}
      </section>
      <Sheet open={Boolean(approving)} onClose={() => setApproving(null)} size="sm" title="Approve this refund?" description={approving ? `${rupees(approving.amount_cents)} goes back to ${approving.customer_name ?? 'the customer'} on the payment method they used. This cannot be undone.` : undefined} footer={<div className="grid grid-cols-2 gap-3"><Button variant="glass" onClick={() => setApproving(null)}>Not now</Button><Button loading={act.isPending} icon={<Check className="h-4 w-4" />} onClick={() => void approve()}>Approve and refund</Button></div>}>
        <p className="text-sm text-fog">{approving?.reason}</p>
      </Sheet>
      <Sheet open={Boolean(resolving)} onClose={() => setResolving(null)} size="sm" title="Record a refund you paid by hand" description="Use this only if you already refunded it from the Razorpay dashboard." footer={<div className="grid gap-3"><Button loading={act.isPending} disabled={rid.trim().length < 4} icon={<Check className="h-4 w-4" />} onClick={() => void resolve('processed')}>Mark refunded</Button><Button variant="danger" onClick={() => void resolve('failed')}>Mark failed</Button></div>}>
        <Input label="Razorpay refund id" value={rid} onChange={(e) => setRid(e.target.value)} placeholder="rfnd_…" hint="Needed to mark it refunded." />
      </Sheet>
    </div>
  );
}

export default function Admin() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const membership = params.get('membership') ?? undefined;
  const go = (t: Tab, extra?: Record<string, string>) => setParams({ tab: t, ...extra });
  return (
    <StaffLayout role="admin" title="Admin">
      <div className="mb-6"><h1 className="text-3xl font-extrabold">WASHO admin</h1></div>
      <div className="mb-6"><Segmented label="Admin sections" value={tab} onChange={(t) => go(t)} options={TABS} /></div>
      {tab === 'overview' && <Overview go={go} />}
      {tab === 'requests' && <Requests />}
      {tab === 'bookings' && (<>{membership && <button onClick={() => go('memberships')} className="mb-4 text-sm font-semibold text-washo-300">← All memberships</button>}<Bookings membership={membership} /></>)}
      {tab === 'memberships' && <Memberships showWashes={(id) => go('bookings', { membership: id })} />}
      {tab === 'people' && <People />}
      {tab === 'attention' && <Attention />}
    </StaffLayout>
  );
}
