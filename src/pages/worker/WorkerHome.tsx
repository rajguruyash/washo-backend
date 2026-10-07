import { ChevronRight, MapPin, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState } from '../../components/EmptyState';
import { Plate } from '../../components/brand/Plate';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Segmented } from '../../components/ui/Segmented';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { friendlyDay } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useWorkerPool, useWorkerQueue, useWorkerStep } from '../../lib/queries';
import { slotLabel, slotWindow } from '../../lib/slots';
import { staffStatus } from '../../lib/status';
import type { WorkerBucket, WorkerWash } from '../../lib/types';

type Tab = WorkerBucket | 'available';

export function ChangeNote({ w }: { w: WorkerWash }) {
  const c = w.change;
  if (!c) return null;
  const text =
    c.kind === 'rescheduled' ? `Moved${c.from_date ? ` from ${friendlyDay(c.from_date)}${c.from_slot ? `, ${slotLabel(c.from_slot)}` : ''}` : ''}${c.by === 'admin' ? ' by WASHO' : c.by === 'worker' ? '' : ' by the customer'}` :
    c.kind === 'cancelled' ? `Cancelled${c.reason ? `: ${c.reason}` : ''}` : 'Reassigned. No longer yours.';
  return <Badge tone={c.kind === 'cancelled' ? 'red' : 'amber'}>{text}</Badge>;
}

function WashCard({ w }: { w: WorkerWash }) {
  const s = staffStatus[w.status];
  const live = w.bucket !== 'changed';
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-washo-300">{friendlyDay(w.scheduled_date)} · {slotLabel(w.time_slot)} <span className="font-normal normal-case text-fog">{slotWindow(w.time_slot)}</span></p>
          <p className="mt-1 truncate text-lg font-bold">{w.service_name}</p>
        </div>
        <Badge tone={w.is_overdue ? 'red' : s.tone}>{w.is_overdue ? 'Overdue' : s.label}</Badge>
      </div>
      {live && (
        <div className="mt-3 space-y-1.5 text-sm">
          <p className="font-semibold">{w.customer_name}</p>
          <div className="flex flex-wrap items-center gap-2">{w.registration_number && <Plate reg={w.registration_number} />}<span className="text-fog">{[w.vehicle_make, w.vehicle_model, w.vehicle_color].filter(Boolean).join(' · ')}</span></div>
          <p className="flex items-start gap-1.5 text-fog"><MapPin className="mt-0.5 h-4 w-4 shrink-0" /> {[w.society_name, w.building_block && `Block ${w.building_block}`, w.flat_number].filter(Boolean).join(', ')}</p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {w.membership_reference && <Badge tone="blue">{w.membership_reference} · wash {w.wash_number}/{w.washes_total}</Badge>}
        {w.customer_confirmed_at && w.bucket !== 'completed' && <Badge tone="green">Customer confirmed</Badge>}
        <ChangeNote w={w} />
      </div>
    </>
  );
  return live ? (
    <Link to={`/worker/washes/${w.booking_id}`} className="glass group flex items-center gap-3 p-4 transition-colors hover:border-washo-400/40"><div className="min-w-0 flex-1">{body}</div><ChevronRight className="h-5 w-5 shrink-0 text-fog transition-transform group-hover:translate-x-0.5" /></Link>
  ) : (
    <div className="glass p-4 opacity-90">{body}</div>
  );
}

export default function WorkerHome() {
  const queue = useWorkerQueue();
  const pool = useWorkerPool();
  const step = useWorkerStep();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('today');
  const rows = queue.data ?? [];
  const by = (b: WorkerBucket) => rows.filter((r) => r.bucket === b);
  // Washes moved but still in the queue also appear under "Cancelled / moved" so nothing changes silently.
  const movedLive = rows.filter((r) => r.bucket !== 'changed' && r.change?.kind === 'rescheduled');
  const changed = [...by('changed'), ...movedLive];
  const list: WorkerWash[] = tab === 'changed' ? changed : tab === 'available' ? [] : by(tab);

  const claim = async (id: string) => {
    try {
      await step.mutateAsync({ id, step: 'claim' });
      toast.success('Added to your queue');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not claim this wash.');
    }
  };

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div><h1 className="text-3xl font-extrabold">Your washes</h1><p className="text-sm text-fog">Only washes assigned to you appear here.</p></div>
        <Button variant="glass" size="sm" icon={<RefreshCw className={`h-4 w-4 ${queue.isFetching ? 'animate-spin' : ''}`} />} onClick={() => { void queue.refetch(); void pool.refetch(); }} aria-label="Refresh" />
      </div>
      <Segmented label="Queue" value={tab} onChange={setTab} options={[
        { value: 'today', label: 'Today', count: by('today').length },
        { value: 'in_progress', label: 'In progress', count: by('in_progress').length },
        { value: 'upcoming', label: 'Upcoming', count: by('upcoming').length },
        { value: 'completed', label: 'Completed' },
        { value: 'changed', label: 'Cancelled / moved', count: changed.length },
        { value: 'available', label: 'Available', count: pool.data?.length },
      ]} />

      <div className="mt-5 space-y-3">
        {queue.isError ? <ErrorState onRetry={() => void queue.refetch()} /> : queue.isLoading ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-32" />) : tab === 'available' ? (
          pool.data?.length ? pool.data.map((p) => (
            <div key={p.booking_id} className="glass flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wider text-washo-300">{friendlyDay(p.scheduled_date)} · {slotLabel(p.time_slot)}</p>
                <p className="mt-1 font-bold">{p.service_name}</p>
                <p className="text-sm text-fog">{p.vehicle_type.toUpperCase()} · {[p.society_name, p.area_locality].filter(Boolean).join(', ')}</p>
              </div>
              <Button size="sm" loading={step.isPending && step.variables?.id === p.booking_id} onClick={() => void claim(p.booking_id)}>Claim</Button>
            </div>
          )) : <EmptyState title="No unassigned washes" text="Paid washes nobody holds yet will appear here." />
        ) : list.length ? list.map((w) => <WashCard key={w.booking_id} w={w} />) : (
          <EmptyState title={{ today: 'Nothing due today', in_progress: 'No wash in progress', upcoming: 'Nothing coming up', completed: 'No completed washes yet', changed: 'No changes', available: '' }[tab]} text="New assignments and changes show up here automatically." />
        )}
      </div>
    </div>
  );
}
