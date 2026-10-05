import { useEffect, useMemo, useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Field';
import { addDays, prettyDate, rupees, todayIST } from '../../lib/format';
import { useAdminHistory, useAdminWorkers } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { staffStatus } from '../../lib/status';
import type { AdminBooking } from '../../lib/types';
import { BookingSheet } from './BookingSheet';
import { Loading } from './shared';

const RANGES = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

/** Every wash that has happened (or been cancelled) in a date range, newest first, with totals for what is on screen. */
export default function History() {
  const [from, setFrom] = useState(addDays(todayIST(), -30));
  const [to, setTo] = useState(todayIST());
  const [status, setStatus] = useState('');
  const [worker, setWorker] = useState('');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const workers = useAdminWorkers('all');
  const filter = useMemo(() => ({ from, to, status: status || undefined, worker: worker || undefined, q: debounced || undefined }), [from, to, status, worker, debounced]);
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isPlaceholderData } = useAdminHistory(filter);
  const [open, setOpen] = useState<string | null>(null);

  const rows: AdminBooking[] = data?.pages.flatMap((p) => p.bookings) ?? [];
  const summary = data?.pages[0]?.summary;
  const activeRange = RANGES.find((r) => from === addDays(todayIST(), -r.days) && to === todayIST());

  return (
    <div className="space-y-4">
      <div className="glass space-y-4 p-4">
        <div className="flex flex-wrap gap-2">
          {RANGES.map((r) => (
            <Button key={r.days} size="sm" variant={activeRange === r ? 'primary' : 'glass'} onClick={() => { setFrom(addDays(todayIST(), -r.days)); setTo(todayIST()); }}>{r.label}</Button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input label="From" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          <Input label="To" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {Object.entries(staffStatus).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
          <Select label="Specialist" value={worker} onChange={(e) => setWorker(e.target.value)}>
            <option value="">Anyone</option>
            {workers.data?.map((w) => <option key={w.id} value={w.id}>{w.full_name}{w.archived ? ' (archived)' : ''}</option>)}
          </Select>
        </div>
        <Input label="Search" placeholder="Customer, phone, vehicle, reference, service or specialist" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {summary && (
        <div className={`grid grid-cols-2 gap-3 lg:grid-cols-4 ${isPlaceholderData ? 'opacity-60' : ''}`}>
          {[
            ['Washes', String(summary.total)],
            ['Completed', String(summary.completed)],
            ['Cancelled or refunded', String(summary.cancelled)],
            ['Single-wash revenue', rupees(summary.single_wash_cents)],
          ].map(([label, value]) => (
            <div key={label} className="glass p-4"><p className="font-display text-2xl font-extrabold tabular-nums">{value}</p><p className="mt-0.5 text-xs text-fog">{label}</p></div>
          ))}
        </div>
      )}
      {summary && <p className="-mt-2 text-xs text-fog">Single-wash revenue is what completed one-off washes were charged. Membership washes are paid for up front and are not counted here.</p>}

      {isError ? <ErrorState onRetry={() => void refetch()} /> : isLoading ? <Loading /> : !rows.length ? <div className="panel p-8 text-center text-fog">No washes match.</div> : (
        <div className="space-y-2">
          {rows.map((b) => (
            <button key={b.id} onClick={() => setOpen(b.id)} className="glass flex w-full flex-wrap items-center gap-x-5 gap-y-2 p-4 text-left transition-colors hover:border-washo-400/40">
              <div className="w-36 shrink-0"><p className="text-sm font-bold">{prettyDate(b.scheduled_date)}</p><p className="text-xs text-fog">{slotLabel(b.time_slot)} · {b.reference_code}</p></div>
              <div className="min-w-0 flex-1"><p className="truncate font-semibold">{b.service_name} · {b.registration_number}</p><p className="truncate text-xs text-fog">{b.customer_name} · {[b.society_name, b.flat_number].filter(Boolean).join(', ')}</p></div>
              <p className="w-32 truncate text-sm text-mist">{b.worker_name ?? <span className="text-fog">No specialist</span>}</p>
              <p className="w-20 text-right text-sm tabular-nums text-mist">{b.booking_type === 'membership' ? 'Membership' : b.price_cents == null ? '' : b.price_cents === 0 ? 'Free' : rupees(b.price_cents)}</p>
              <Badge tone={staffStatus[b.status].tone}>{staffStatus[b.status].label}</Badge>
            </button>
          ))}
          {hasNextPage && <div className="pt-2 text-center"><Button variant="glass" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>Show more ({(summary?.total ?? 0) - rows.length} left)</Button></div>}
        </div>
      )}
      <BookingSheet id={open} onClose={() => setOpen(null)} />
    </div>
  );
}
