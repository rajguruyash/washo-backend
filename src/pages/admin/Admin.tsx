import { AlertTriangle, CalendarPlus, Check, Hourglass } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorState } from '../../components/EmptyState';
import { QuoteBreakdownView } from '../../components/Quote';
import { patternLabel } from '../../components/WashBits';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select, TextArea } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { addDays, fullDate, istDay, prettyDate, prettyPhone, rupees, todayIST } from '../../lib/format';
import {
  useAdminAction, useAdminAttention, useAdminBookings, useAdminMemberships, useAdminOverview, useAdminRequests, useAdminWorkers, useReviewRequest, useRefreshAll,
} from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { staffStatus } from '../../lib/status';
import type { AdminBooking, AdminMembership, AdminRequest, Attention as AttentionData, RequestStatus, SlotId } from '../../lib/types';
import { StaffLayout } from '../../layouts/StaffLayout';
import { ROLE_LABEL, canDo, isReadOnly } from '../../lib/adminAccess';
import { useAuth } from '../../state/auth';
import Activity from './Activity';
import { AddWashSheet } from './AddWash';
import { BookingSheet } from './BookingSheet';
import Capacity from './Capacity';
import { Dashboard } from './Dashboard';
import Export from './Export';
import Campaigns from './Campaigns';
import History from './History';
import People from './People';
import Discounts from './Discounts';
import ServicesAdmin from './ServicesAdmin';
import Renewals from './Renewals';
import Settings from './Settings';
import Support from './Support';
import Team from './Team';
import { Loading, errText } from './shared';
import { monthlyDetail, planTitle } from '../../lib/plan';

type Tab = 'overview' | 'requests' | 'bookings' | 'history' | 'memberships' | 'people' | 'services' | 'discounts' | 'campaigns' | 'capacity' | 'attention' | 'support' | 'export' | 'activity' | 'team' | 'settings';
// Each tab belongs to an area of the console; the admin sees the tabs their role may at least look at (the server checks every request again).
const TABS: { value: Tab; label: string; area: string | ((a: Parameters<typeof canDo>[0]) => boolean) }[] = [
  { value: 'overview', label: 'Dashboard', area: 'overview' },
  { value: 'bookings', label: 'Washes', area: 'bookings' },
  { value: 'memberships', label: 'Memberships', area: 'memberships' },
  { value: 'people', label: 'People', area: 'people' },
  { value: 'requests', label: 'Requests', area: 'requests' },
  { value: 'history', label: 'History', area: 'history' },
  { value: 'services', label: 'Services & prices', area: 'services' },
  { value: 'discounts', label: 'Discounts', area: (a) => canDo(a, 'services') || canDo(a, 'campaigns') },
  { value: 'campaigns', label: 'Campaigns', area: 'campaigns' },
  { value: 'capacity', label: 'Capacity', area: 'capacity' },
  { value: 'attention', label: 'Payments & refunds', area: 'payments' },
  { value: 'support', label: 'Support', area: 'support' },
  { value: 'export', label: 'Export', area: (a) => ['customers', 'washes', 'memberships', 'payments', 'refunds', 'support', 'activity'].some((k) => canDo(a, `export_${k}`, 'manage')) },
  { value: 'activity', label: 'Activity log', area: 'activity' },
  { value: 'team', label: 'Team', area: 'team' },
  { value: 'settings', label: 'Settings', area: 'settings' },
];
/** The area a tab's content is governed by (used to say "view only"). */
const AREA_OF_TAB: Partial<Record<Tab, string>> = { overview: 'overview', bookings: 'bookings', memberships: 'memberships', people: 'people', requests: 'requests', history: 'history', services: 'services', discounts: 'services', campaigns: 'campaigns', capacity: 'capacity', attention: 'payments', support: 'support', activity: 'activity', team: 'team', settings: 'settings' };


// ───────────────────────── overview ─────────────────────────
function Overview({ go, allowed }: { go: (t: Tab) => void; allowed: (t: Tab) => boolean }) {
  const { data: o, isLoading, isError, refetch } = useAdminOverview();
  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !o) return <Loading />;
  const tile = (label: string, value: number, tab: Tab, hot = false) => {
    const body = (
      <>
        <p className={`font-display text-4xl font-extrabold tabular-nums ${hot && value > 0 ? 'text-warn' : ''}`}>{value}</p>
        <p className="mt-1 text-sm text-fog">{label}</p>
      </>
    );
    const cls = `glass p-5 text-left ${hot && value > 0 ? 'border-warn/40' : ''}`;
    return allowed(tab) ? <button key={label} onClick={() => go(tab)} className={`${cls} transition-colors hover:border-washo-400/40`}>{body}</button> : <div key={label} className={cls}>{body}</div>;
  };
  return (
    <>
      <Dashboard go={(t) => allowed(t) && go(t)} />
      <h2 className="mb-3 text-lg font-bold">Washes and memberships</h2>
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
    </>
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
                <div><p className="eyebrow">{r.reference_code}</p><p className="mt-1 text-lg font-bold">{planTitle(r, { short: true })}</p></div>
                <Badge tone={r.status === 'submitted' ? 'amber' : r.status === 'quoted' ? 'blue' : r.status === 'active' ? 'green' : 'slate'}>{r.status}</Badge>
              </div>
              <p className="mt-2 text-sm font-semibold">{r.customer.name} <a href={`tel:${r.customer.phone}`} className="font-normal text-washo-300">{prettyPhone(r.customer.phone)}</a></p>
              <p className="mt-1 text-sm text-fog">{r.vehicle.type.toUpperCase()} · {r.vehicle.model} · {r.vehicle.registration_number}</p>
              <p className="mt-1 text-sm text-mist">{monthlyDetail(r, r.vehicle.type === 'bike') ?? patternLabel(r.weekly_pattern)} · {slotLabel(r.time_slot)}</p>
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
function Bookings({ membership, canAdd, onAdd }: { membership?: string; canAdd: boolean; onAdd: () => void }) {
  const [from, setFrom] = useState(todayIST());
  const [to, setTo] = useState(addDays(todayIST(), 7));
  const [status, setStatus] = useState('');
  const [unassigned, setUnassigned] = useState(false);
  const filter = useMemo(() => (membership ? { membership } : { from, to, status: status || undefined, unassigned }), [membership, from, to, status, unassigned]);
  const { data, isLoading, isError, refetch } = useAdminBookings(filter);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {!membership && canAdd && <div className="flex justify-end"><Button size="sm" icon={<CalendarPlus className="h-4 w-4" />} onClick={onAdd}>Book a wash</Button></div>}
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
              <div className="min-w-0 flex-1"><p className="truncate font-semibold">{b.service_name} · {b.registration_number}{b.campaign_name ? ' · free wash' : ''}</p><p className="truncate text-xs text-fog">{b.customer_name} · {[b.society_name, b.flat_number].filter(Boolean).join(', ')}</p></div>
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
function Memberships({ showWashes, canManage }: { showWashes: (id: string) => void; canManage: boolean }) {
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
      <Renewals canEdit={canManage} />
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.map((m) => (
          <div key={m.id} className="glass p-5">
            <div className="flex items-start justify-between gap-3"><div><p className="eyebrow">{m.reference_code}</p><p className="mt-1 text-lg font-bold">{planTitle(m, { short: true })} · {rupees(m.final_amount_cents)}</p></div><Badge tone={m.status === 'active' ? 'green' : 'slate'}>{m.status}</Badge></div>
            <p className="mt-2 text-sm font-semibold">{m.customer_name} <span className="font-normal text-fog">{prettyPhone(m.customer_phone)}</span></p>
            <p className="text-sm text-fog">{m.vehicle_type?.toUpperCase()} · {m.vehicle_model} · {m.registration_number}</p>
            {(m.monthly_body != null || m.weekly_pattern) && <p className="mt-1 text-sm text-mist">{monthlyDetail(m, m.vehicle_type === 'bike') ?? patternLabel(m.weekly_pattern ?? [])}{m.time_slot ? ` · ${slotLabel(m.time_slot)}` : ''}</p>}
            <p className="mt-1 text-xs text-fog">{m.washes_completed}/{m.washes_total} done · {fullDate(istDay(m.start_at))} to {fullDate(istDay(m.end_at))}{m.next_wash_date ? ` · next ${prettyDate(m.next_wash_date)}` : ''}</p>
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

// ───────────────────────── needs attention ─────────────────────────
function Attention() {
  const { data, isLoading, isError, refetch } = useAdminAttention();
  const act = useAdminAction();
  const refresh = useRefreshAll();
  const toast = useToast();
  const [approving, setApproving] = useState<AttentionData['refunds'][number] | null>(null);
  const [typed, setTyped] = useState(''); // for a big refund: the amount, typed back
  const [resolving, setResolving] = useState<string | null>(null);
  const [rid, setRid] = useState('');
  const [checking, setChecking] = useState<string | null>(null);
  const check = async (id: string) => {
    setChecking(id);
    try {
      const r = await act.mutateAsync({ path: `payments/${id}/reconcile`, body: {} });
      if (r.status === 'fulfilled') toast.success('Found the payment at Razorpay. It is recorded and booked.');
      else if (r.status === 'already_settled' || r.status === 'already_recorded') toast.success('That payment is already recorded.');
      else if (r.status === 'unfulfilled') toast.error('Razorpay has the payment but it could not be turned into a booking (the slot may have passed). A refund request was created below.');
      else if (r.status === 'not_paid') toast.error('Razorpay shows no completed payment for this checkout. If the customer insists they paid, look for it in the Razorpay dashboard.');
      else toast.error(`Razorpay answered "${r.status}". Nothing was recorded.`);
    } catch (e) { toast.error(errText(e)); } finally { setChecking(null); }
  };
  const approve = async () => {
    if (!approving) return;
    try {
      await act.mutateAsync({ path: `refunds/${approving.id}/approve`, body: bigRefund(approving) ? { confirm_amount_cents: approving.amount_cents } : {} });
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
  const policy = data.policy;
  const bigRefund = (r: { amount_cents: number }) => Boolean(policy) && r.amount_cents >= policy.threshold_cents;
  // A big refund needs the super admin, and the amount typed back so it cannot be approved by a stray tap.
  const blocked = approving && bigRefund(approving) && !policy.can_approve_big;
  const typedOk = !approving || !bigRefund(approving) || Math.round((Number(typed.replace(/[^0-9.]/g, '')) || 0) * 100) === approving.amount_cents;
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-bold"><AlertTriangle className="h-5 w-5 text-warn" /> Paid but not fulfilled</h2>
        {data.unfulfilled.length ? <ul className="space-y-2">{data.unfulfilled.map((p) => <li key={p.id} className="panel p-4 text-sm"><p className="font-semibold">{rupees(p.amount_cents)} · {p.payment_kind} · {p.customer_name} {prettyPhone(p.customer_phone)}</p><p className="text-xs text-fog">Razorpay payment {p.provider_payment_id}. A refund request was created automatically.</p></li>)}</ul> : <p className="panel p-5 text-sm text-fog">Nothing. Every verified payment became a booking or membership.</p>}
      </section>
      <section>
        <h2 className="mb-1 flex items-center gap-2 text-lg font-bold"><Hourglass className="h-5 w-5 text-washo-300" /> Started but not confirmed</h2>
        <p className="mb-3 text-sm text-fog">Checkouts that were opened and never reported back. If a customer says they paid, press <strong className="text-white">Check with Razorpay</strong>: if Razorpay has the payment, the wash or membership is recorded.</p>
        {data.pending.length ? <ul className="space-y-2">{data.pending.map((p) => (
          <li key={p.id} className="panel flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="text-sm"><p className="font-semibold">{rupees(p.amount_cents)} · {p.payment_kind === 'membership' ? 'Membership' : 'Single wash'} · {p.customer_name} {prettyPhone(p.customer_phone)}</p><p className="text-xs text-fog">Started {new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(p.created_at))}{p.scheduled_date ? ` · for ${prettyDate(p.scheduled_date)}${p.time_slot ? `, ${slotLabel(p.time_slot as SlotId)}` : ''}` : ''}</p></div>
            <Button size="sm" variant="glass" loading={act.isPending && checking === p.id} onClick={() => void check(p.id)}>Check with Razorpay</Button>
          </li>
        ))}</ul> : <p className="panel p-5 text-sm text-fog">Nothing waiting. Every checkout that was started has either finished or is still in progress.</p>}
      </section>
      <section>
        <h2 className="mb-1 text-lg font-bold">Refund requests</h2>
        <p className="mb-3 text-sm text-fog">Nothing is refunded until you approve it. Approving sends the full amount back to the customer through Razorpay.</p>
        {data.refunds.length ? <ul className="space-y-2">{data.refunds.map((r) => (
          <li key={r.id} className="panel flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="text-sm">
              <p className="font-semibold">{rupees(r.amount_cents)}{bigRefund(r) && <Badge tone="amber" className="ml-2 align-middle">Big refund</Badge>} · {r.customer_name} {prettyPhone(r.customer_phone)}</p>
              <p className="text-xs text-fog">{r.reason} · {r.status}</p>
              {r.status === 'failed' && r.failure_reason && <p className="mt-1 text-xs text-warn">Razorpay said: {r.failure_reason}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setResolving(r.id)}>Paid it by hand</Button>
              <Button size="sm" onClick={() => { setTyped(''); setApproving(r); }}>{r.status === 'failed' ? 'Try again' : 'Approve and refund'}</Button>
            </div>
          </li>
        ))}</ul> : <p className="panel p-5 text-sm text-fog">No open refunds.</p>}
      </section>
      <Sheet open={Boolean(approving)} onClose={() => setApproving(null)} size="sm" title="Approve this refund?" description={approving ? `${rupees(approving.amount_cents)} goes back to ${approving.customer_name ?? 'the customer'} on the payment method they used. This cannot be undone.` : undefined} footer={<div className="grid grid-cols-2 gap-3"><Button variant="glass" onClick={() => setApproving(null)}>Not now</Button><Button loading={act.isPending} disabled={Boolean(blocked) || !typedOk} icon={<Check className="h-4 w-4" />} onClick={() => void approve()}>Approve and refund</Button></div>}>
        <p className="text-sm text-fog">{approving?.reason}</p>
        {approving && bigRefund(approving) && (blocked ? (
          <p role="alert" className="mt-4 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm text-warn">This is a big refund ({rupees(policy.threshold_cents)} or more). Only the super admin can approve it. Ask them to open this page.</p>
        ) : (
          <div className="mt-4 space-y-2">
            <p className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm text-warn">This is a big refund. To be sure, type the amount below.</p>
            <Input label={`Type ${approving.amount_cents / 100} to confirm (₹)`} inputMode="decimal" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
        ))}
      </Sheet>
      <Sheet open={Boolean(resolving)} onClose={() => setResolving(null)} size="sm" title="Record a refund you paid by hand" description="Use this only if you already refunded it from the Razorpay dashboard." footer={<div className="grid gap-3"><Button loading={act.isPending} disabled={rid.trim().length < 4} icon={<Check className="h-4 w-4" />} onClick={() => void resolve('processed')}>Mark refunded</Button><Button variant="danger" onClick={() => void resolve('failed')}>Mark failed</Button></div>}>
        <Input label="Razorpay refund id" value={rid} onChange={(e) => setRid(e.target.value)} placeholder="rfnd_…" hint="Needed to mark it refunded." />
      </Sheet>
    </div>
  );
}

export default function Admin() {
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const access = user?.admin;
  const visible = useMemo(() => TABS.filter((x) => (typeof x.area === 'function' ? x.area(access) : canDo(access, x.area))), [access]);
  const requested = (params.get('tab') as Tab) || 'overview';
  const tab: Tab = visible.some((x) => x.value === requested) ? requested : (visible[0]?.value ?? 'overview');
  const membership = params.get('membership') ?? undefined;
  const go = (t: Tab, extra?: Record<string, string>) => setParams({ tab: t, ...extra });
  const allowed = (t: Tab) => visible.some((x) => x.value === t);
  const area = AREA_OF_TAB[tab];
  const readOnly = Boolean(area) && isReadOnly(access, area!);
  // "Book a wash" is available from the Washes tab (pick any customer) and from a customer's page (that customer).
  const [adding, setAdding] = useState<{ customerId: string | null } | null>(null);
  return (
    <StaffLayout role="admin" title={access ? `Admin · ${ROLE_LABEL[access.access]}` : 'Admin'}>
      <div className="mb-6"><h1 className="text-3xl font-extrabold">WASHO admin</h1></div>
      {!access ? (
        <div role="alert" className="glass max-w-xl p-6"><h2 className="text-lg font-bold">Your account has no role yet</h2><p className="mt-2 text-sm text-fog">You are signed in, but the super admin has not given you a role, so there is nothing you can open. Ask them to add you under Team.</p></div>
      ) : (
        <>
          <div className="mb-6"><Segmented label="Admin sections" value={tab} onChange={(t) => go(t)} options={visible.map((x) => ({ value: x.value, label: x.label }))} /></div>
          {readOnly && <p role="note" className="mb-5 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-fog">Your role can look at this page but not change anything on it.</p>}
          {tab === 'overview' && <Overview go={go} allowed={allowed} />}
          {tab === 'requests' && <Requests />}
          {tab === 'bookings' && (<>{membership && <button onClick={() => go('memberships')} className="mb-4 text-sm font-semibold text-washo-300">← All memberships</button>}<Bookings membership={membership} canAdd={canDo(access, 'bookings', 'manage')} onAdd={() => setAdding({ customerId: null })} /></>)}
          {tab === 'history' && <History />}
          {tab === 'memberships' && <Memberships showWashes={(id) => go('bookings', { membership: id })} canManage={canDo(access, 'memberships', 'manage')} />}
          {tab === 'people' && <People onBook={(customerId) => setAdding({ customerId })} />}
          {tab === 'services' && <ServicesAdmin />}
          {tab === 'discounts' && <Discounts rules={canDo(access, 'services')} editRules={canDo(access, 'services', 'manage')} coupons={canDo(access, 'campaigns')} editCoupons={canDo(access, 'campaigns', 'manage')} />}
          {tab === 'campaigns' && <Campaigns />}
          {tab === 'capacity' && <Capacity />}
          {tab === 'attention' && <Attention />}
          {tab === 'support' && <Support canReply={canDo(access, 'support', 'manage')} />}
          {tab === 'export' && <Export />}
          {tab === 'activity' && <Activity />}
          {tab === 'team' && <Team />}
          {tab === 'settings' && <Settings canEdit={canDo(access, 'settings', 'manage')} />}
        </>
      )}
      <AddWashSheet open={Boolean(adding)} customerId={adding?.customerId} onClose={() => setAdding(null)} onCreated={() => go('bookings')} />
    </StaffLayout>
  );
}
