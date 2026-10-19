import { ChevronRight, MapPin, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState } from '../../components/EmptyState';
import { Plate } from '../../components/brand/Plate';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { PoolWashCard } from '../../components/PoolWashCard';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet } from '../../components/ui/Sheet';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { ALL_BUILDINGS, ALL_SOCIETIES, buildingOptions, inBuilding, inSociety, societyOptions } from '../../lib/buildings';
import { clusterSocieties } from '../../lib/societyCluster';
import { DONE_LABEL, DONE_WORDS, inRange, type DoneRange } from '../../lib/doneRange';
import { friendlyDay, todayIST } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useWorkerPool, useWorkerQueue, useWorkerStep } from '../../lib/queries';
import { slotLabel, slotWindow } from '../../lib/slots';
import { useSticky } from '../../lib/sticky';
import { staffStatus } from '../../lib/status';
import type { PoolWash, WorkerBucket, WorkerWash } from '../../lib/types';
import { WorkerSearch } from './WorkerSearch';

type Tab = WorkerBucket | 'available';

// A wash that is no longer yours has its details hidden, building included, so it can only be found under "All buildings".
const asRow = (r: WorkerWash) => ({ building_block: r.building_block, society_name: r.society_name, hidden: r.bucket === 'changed' });

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
  // The tab, society and building stay as the specialist chose them: open a wash, press the back arrow, and the list is exactly as it was left.
  const [tab, setTab] = useSticky<Tab>('worker.tab', 'today');
  const [society, setSociety] = useSticky('worker.society', ALL_SOCIETIES);
  const [building, setBuilding] = useSticky('worker.building', ALL_BUILDINGS);
  // The Completed tab can be narrowed to the day a wash was finished (it used to list every wash ever completed).
  const [done, setDone] = useSticky<DoneRange>('worker.done', 'today');
  const all = useMemo(() => queue.data ?? [], [queue.data]);
  const poolRows = useMemo(() => pool.data ?? [], [pool.data]);
  // Society first (only when the specialist works in more than one), then the buildings of that society. Available (unclaimed washes) can be narrowed by society only.
  // One society written several ways ("Purva Silversands", "Purva Sliversands Mundhwa") is one society. Grouped across the queue AND the unclaimed washes, so the groups are the same on every tab.
  const clusters = useMemo(() => clusterSocieties([...all.filter((r) => r.bucket !== 'changed').map((r) => r.society_name), ...poolRows.map((p) => p.society_name)]), [all, poolRows]);
  const societies = useMemo(() => societyOptions<{ society_name: string | null; hidden?: boolean }>(tab === 'available' ? poolRows : all.map(asRow), clusters), [tab, poolRows, all, clusters]);
  // A remembered choice that does not apply (no such society in this list any more) means "all", but is kept for when it applies again. The group may have been renamed since, so it is found by any name in it.
  const remembered = society === ALL_SOCIETIES ? society : clusters.keyOf(society) || society;
  const soc = remembered === ALL_SOCIETIES || societies.some((x) => x.value === remembered) ? remembered : ALL_SOCIETIES;
  const inSoc = useMemo(() => all.filter((r) => inSociety(asRow(r), soc, clusters)), [all, soc, clusters]);
  // Unclaimed washes now say which building they are in (migration 48); a database without it has no building on them, so there is nothing to filter by.
  const poolHasBuildings = poolRows.some((p) => p.building_block !== undefined);
  const poolInSoc = useMemo(() => poolRows.filter((p) => inSociety(p, soc, clusters)), [poolRows, soc, clusters]);
  const poolRow = (p: PoolWash) => ({ building_block: p.building_block ?? null });
  const buildings = useMemo(() => (tab === 'available' ? (poolHasBuildings ? buildingOptions(poolInSoc.map(poolRow)) : []) : buildingOptions(inSoc.map(asRow))), [tab, poolHasBuildings, poolInSoc, inSoc]);
  const bld = building === ALL_BUILDINGS || buildings.some((b) => b.value === building) ? building : ALL_BUILDINGS;
  const rows = inSoc.filter((r) => inBuilding(asRow(r), bld));
  const by = (b: WorkerBucket) => rows.filter((r) => r.bucket === b);
  // Washes moved but still in the queue also appear under "Cancelled / moved" so nothing changes silently.
  const changedOf = (l: WorkerWash[]) => [...l.filter((r) => r.bucket === 'changed'), ...l.filter((r) => r.bucket !== 'changed' && r.change?.kind === 'rescheduled')];
  const inOpenTab = (l: WorkerWash[]) => (tab === 'changed' ? changedOf(l) : tab === 'available' ? [] : l.filter((r) => r.bucket === tab));
  const changed = changedOf(rows);
  const today = todayIST();
  const completedAll = by('completed');
  const doneCount = (r: DoneRange) => completedAll.filter((w) => inRange(w, r, today)).length;
  const completedShown = completedAll.filter((w) => inRange(w, done, today)).sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
  const list: WorkerWash[] = tab === 'available' ? [] : tab === 'changed' ? changed : tab === 'completed' ? completedShown : by(tab);
  const poolShown = poolInSoc.filter((p) => !poolHasBuildings || inBuilding(poolRow(p), bld));
  // chip counts are for the tab that is open
  const societyCount = (value: string) => (tab === 'available' ? poolRows.filter((p) => inSociety(p, value, clusters)).length : inOpenTab(all.filter((r) => inSociety(asRow(r), value, clusters))).length);
  const buildingCount = (value: string) => (tab === 'available' ? poolInSoc.filter((p) => inBuilding(poolRow(p), value)).length : inOpenTab(inSoc.filter((r) => inBuilding(asRow(r), value))).length);
  const placeLabel = [buildings.find((b) => b.value === bld)?.label, societies.find((x) => x.value === soc)?.label].filter(Boolean).join(' · ');
  const filtered = soc !== ALL_SOCIETIES || bld !== ALL_BUILDINGS;

  // An unclaimed wash opened from the search, with its details and a Claim button.
  const [viewing, setViewing] = useState<PoolWash | null>(null);
  const claim = async (id: string) => {
    try {
      await step.mutateAsync({ id, step: 'claim' });
      toast.success('Added to your queue');
      setViewing(null);
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
      <WorkerSearch all={all} pool={poolRows} onPool={setViewing} />
      <Segmented label="Queue" value={tab} onChange={setTab} options={[
        { value: 'today', label: 'Today', count: by('today').length },
        { value: 'in_progress', label: 'In progress', count: by('in_progress').length },
        { value: 'upcoming', label: 'Upcoming', count: by('upcoming').length },
        { value: 'completed', label: 'Completed', count: doneCount('today') },
        { value: 'changed', label: 'Cancelled / moved', count: changed.length },
        { value: 'available', label: 'Available', count: poolShown.length },
      ]} />

      {tab === 'completed' && (
        <div className="mt-3">
          <Segmented label="Finished" value={done} onChange={setDone} options={(Object.keys(DONE_LABEL) as DoneRange[]).map((r) => ({ value: r, label: DONE_LABEL[r], count: doneCount(r) }))} />
        </div>
      )}

      {societies.length > 1 && (
        <div className="mt-3">
          <Segmented label="Society" value={soc} onChange={setSociety} options={[{ value: ALL_SOCIETIES, label: 'All societies' }, ...societies.map((x) => ({ value: x.value, label: x.label, count: societyCount(x.value) }))]} />
        </div>
      )}
      {buildings.length > 0 && (
        <div className="mt-3">
          <Segmented label="Building" value={bld} onChange={setBuilding} options={[{ value: ALL_BUILDINGS, label: 'All buildings' }, ...buildings.map((b) => ({ value: b.value, label: b.label, count: buildingCount(b.value) }))]} />
        </div>
      )}
      {filtered && tab === 'changed' && <p className="mt-2 text-xs text-fog">Washes that are no longer yours do not show where they are, so they are only under All societies and All buildings.</p>}

      <div className="mt-5 space-y-3">
        {queue.isError ? <ErrorState onRetry={() => void queue.refetch()} /> : queue.isLoading ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-32" />) : tab === 'available' ? (
          poolShown.length ? poolShown.map((p) => (
            <PoolWashCard key={p.booking_id} p={p} claiming={step.isPending && step.variables?.id === p.booking_id} onClaim={() => void claim(p.booking_id)} />
          )) : filtered ? <EmptyState title={`No unassigned washes in ${placeLabel}`} text="Choose another building or society, or All." /> : <EmptyState title="No unassigned washes" text="Paid washes nobody holds yet will appear here." />
        ) : list.length ? list.map((w) => <WashCard key={w.booking_id} w={w} />) : filtered && tab !== 'completed' ? (
          <EmptyState title={`No washes in ${placeLabel} here`} text="Choose another building or society, or All." />
        ) : tab === 'completed' ? (
          <EmptyState title={`No washes completed ${DONE_WORDS[done]}`} text={done === 'all' ? 'Finished washes show up here.' : 'Choose another day above, or All, to see earlier washes.'} />
        ) : (
          <EmptyState title={{ today: 'Nothing due today', in_progress: 'No wash in progress', upcoming: 'Nothing coming up', completed: 'No completed washes yet', changed: 'No changes', available: '' }[tab]} text="New assignments and changes show up here automatically." />
        )}
      </div>

      <Sheet open={Boolean(viewing)} onClose={() => setViewing(null)} size="sm" title="Unclaimed wash" description="Take it and it moves to your queue, with the customer's details.">
        {viewing && <PoolWashCard bare p={viewing} claiming={step.isPending && step.variables?.id === viewing.booking_id} onClaim={() => void claim(viewing.booking_id)} />}
      </Sheet>
    </div>
  );
}
