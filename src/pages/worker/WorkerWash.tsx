import { AlertTriangle, ArrowLeft, Check, MapPin, MessageSquarePlus, Phone, PhoneMissed, PlayCircle, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/EmptyState';
import { PhotoUploader } from '../../components/PhotoUploader';
import { Plate } from '../../components/brand/Plate';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { TextArea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { friendlyDay, prettyPhone } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useWorkerQueue, useWorkerStep, type WorkerStep } from '../../lib/queries';
import { slotLabel, slotWindow } from '../../lib/slots';
import { staffStatus } from '../../lib/status';
import { ChangeNote } from './WorkerHome';

const ISSUES = [
  { id: 'customer_unavailable', label: 'Customer unavailable' },
  { id: 'vehicle_not_accessible', label: 'Vehicle not accessible' },
  { id: 'no_water_or_power', label: 'No water or power' },
  { id: 'damage_noticed', label: 'Damage noticed' },
  { id: 'safety_concern', label: 'Safety concern' },
  { id: 'other', label: 'Something else' },
] as const;

const Info = ({ label, children }: { label: string; children: React.ReactNode }) => (<div><p className="eyebrow">{label}</p><div className="mt-1 text-sm">{children}</div></div>);

export default function WorkerWash() {
  const { id } = useParams();
  const { data, isLoading, isError, refetch } = useWorkerQueue();
  const step = useWorkerStep();
  const toast = useToast();
  const [sheet, setSheet] = useState<'issue' | 'note' | 'unreached' | null>(null);
  const [kind, setKind] = useState<(typeof ISSUES)[number]['id']>('other');
  const [text, setText] = useState('');

  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !data) return <div className="space-y-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;
  const w = data.find((x) => x.booking_id === id);
  if (!w) return <div className="glass p-8 text-center"><p className="font-semibold">This wash is not in your queue.</p><p className="mt-1 text-sm text-fog">It may have been moved or reassigned.</p><Link to="/worker" className="mt-4 inline-block text-sm font-semibold text-washo-300">Back to your washes</Link></div>;

  const run = async (s: WorkerStep, body?: Record<string, unknown>, ok?: string) => {
    try {
      await step.mutateAsync({ id: w.booking_id, step: s, body });
      if (ok) toast.success(ok);
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That did not work. Please try again.');
      return false;
    }
  };
  const busy = step.isPending;
  const confirmed = Boolean(w.customer_confirmed_at);
  const holds = w.bucket !== 'changed';
  const st = staffStatus[w.status];

  const phase: 'call' | 'respond' | 'retry' | 'start' | 'work' | 'done' | 'closed' =
    !holds || ['cancelled', 'refunded', 'refund_requested', 'no_show'].includes(w.status) ? 'closed' :
    w.status === 'completed' ? 'done' :
    w.status === 'in_progress' ? 'work' :
    w.status === 'call_not_picked_up' ? 'retry' :
    w.status === 'worker_called' ? (confirmed ? 'start' : 'respond') : 'call';

  const submitSheet = async () => {
    const ok =
      sheet === 'issue' ? await run('issue', { kind, notes: text }, 'Issue reported to WASHO') :
      sheet === 'note' ? await run('note', { note: text }, 'Note saved') :
      await run('not-picked-up', { notes: text }, 'Marked as not picked up. The wash stays scheduled.');
    if (ok) { setSheet(null); setText(''); }
  };

  return (
    <div>
      <Link to="/worker" className="mb-4 inline-flex items-center gap-1.5 text-sm text-fog hover:text-white"><ArrowLeft className="h-4 w-4" /> Your washes</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">{w.reference_code}{w.membership_reference ? ` · ${w.membership_reference}` : ''}</p>
          <h1 className="mt-1 text-3xl font-extrabold">{w.service_name}</h1>
          <p className="mt-1 text-sm text-fog">{friendlyDay(w.scheduled_date)} · {slotLabel(w.time_slot)} ({slotWindow(w.time_slot)})</p>
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <div className="mb-4 flex flex-wrap gap-2"><ChangeNote w={w} />{w.membership_label && <Badge tone="blue">{w.membership_label}{w.wash_number ? ` · wash ${w.wash_number} of ${w.washes_total}` : ''}</Badge>}</div>

      {holds && (
        <div className="glass mb-5 grid gap-5 p-5 sm:grid-cols-2">
          <Info label="Customer"><p className="font-semibold">{w.customer_name}</p>{w.customer_phone && <a href={`tel:${w.customer_phone}`} className="text-washo-300 hover:text-white">{prettyPhone(w.customer_phone)}</a>}</Info>
          <Info label="Vehicle"><div className="flex flex-wrap items-center gap-2">{w.registration_number && <Plate reg={w.registration_number} />}</div><p className="mt-1 text-fog">{w.vehicle_type.toUpperCase()} · {[w.vehicle_make, w.vehicle_model, w.vehicle_color].filter(Boolean).join(' · ')}</p></Info>
          <Info label="Address"><p className="flex items-start gap-1.5"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-washo-300" />{[w.society_name, w.building_block && `Block ${w.building_block}`, w.flat_number].filter(Boolean).join(', ')}</p><p className="text-fog">{[w.area_locality, w.city].filter(Boolean).join(', ')}</p></Info>
          <Info label="Parking">{w.parking_location ?? '—'}</Info>
          {(w.instructions || w.target_completion_time) && <div className="sm:col-span-2"><Info label="Special instructions"><p className="text-mist">{w.instructions}</p>{w.target_completion_time && <p className="text-fog">Finish by: {w.target_completion_time}</p>}</Info></div>}
        </div>
      )}

      {phase === 'closed' && <div className="glass p-6 text-center"><AlertTriangle className="mx-auto h-7 w-7 text-warn" /><p className="mt-2 font-semibold">{w.change?.kind === 'cancelled' ? 'This wash was cancelled.' : 'This wash is no longer yours.'}</p><p className="mt-1 text-sm text-fog">Customer details are hidden once a wash leaves your queue.</p></div>}

      {(phase === 'call' || phase === 'retry') && (
        <div className="glass p-5">
          <h2 className="text-lg font-bold">1 · Call the customer</h2>
          <p className="mt-1 text-sm text-fog">{phase === 'retry' ? `They did not pick up. Calls so far: ${w.calls_made}. The wash is still scheduled.` : 'Confirm they are ready before you start.'}</p>
          <a href={`tel:${w.customer_phone}`} onClick={() => void run('call')} className="mt-4 inline-flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-b from-washo-500 to-washo-700 text-base font-semibold text-white"><Phone className="h-5 w-5" /> Call {w.customer_name?.split(' ')[0]}</a>
        </div>
      )}

      {phase === 'respond' && (
        <div className="glass p-5">
          <h2 className="text-lg font-bold">2 · How did the call go?</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Button size="lg" loading={busy} icon={<Check className="h-5 w-5" />} onClick={() => void run('confirm', undefined, 'Customer confirmed')}>Customer confirmed</Button>
            <Button size="lg" variant="glass" icon={<PhoneMissed className="h-5 w-5" />} onClick={() => setSheet('unreached')}>Call not picked up</Button>
          </div>
          <a href={`tel:${w.customer_phone}`} onClick={() => void run('call')} className="mt-4 inline-block text-sm font-semibold text-washo-300">Call again</a>
        </div>
      )}

      {phase === 'start' && (
        <div className="glass p-5">
          <h2 className="text-lg font-bold">3 · Start the wash</h2>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-ok"><ShieldCheck className="h-4 w-4" /> Customer confirmed</p>
          <Button size="lg" full className="mt-4" loading={busy} icon={<PlayCircle className="h-5 w-5" />} onClick={() => void run('start', undefined, 'Wash started')}>Start wash</Button>
        </div>
      )}

      {phase === 'work' && (
        <div className="space-y-5">
          <div className="glass p-5"><h2 className="text-lg font-bold">4 · Before photos</h2><p className="mb-4 mt-1 text-sm text-fog">Photograph the vehicle before you begin.</p><PhotoUploader bookingId={w.booking_id} phase="before" /></div>
          <div className="glass p-5"><h2 className="text-lg font-bold">5 · After photos</h2><p className="mb-4 mt-1 text-sm text-fog">When the wash is done, photograph the result.</p><PhotoUploader bookingId={w.booking_id} phase="after" /></div>
          <div className="glass p-5">
            <h2 className="text-lg font-bold">6 · Complete</h2>
            <Button size="lg" full className="mt-4" disabled={w.photos_before < 1 || w.photos_after < 1} loading={busy} icon={<Check className="h-5 w-5" />} onClick={() => void run('complete', undefined, 'Wash completed')}>Mark wash completed</Button>
            {(w.photos_before < 1 || w.photos_after < 1) && <p className="mt-2 text-center text-xs text-fog">Needs at least one before and one after photo.</p>}
          </div>
        </div>
      )}

      {phase === 'done' && <div className="glass p-6 text-center"><Check className="mx-auto h-8 w-8 text-ok" strokeWidth={3} /><p className="mt-2 text-lg font-bold">Wash completed</p><p className="mt-1 text-sm text-fog">{w.membership_id ? 'The next wash in this membership is already in your queue.' : 'Thanks!'}</p><Link to="/worker" className="mt-4 inline-block text-sm font-semibold text-washo-300">Back to your washes</Link></div>}

      {holds && phase !== 'done' && phase !== 'closed' && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Button variant="glass" icon={<AlertTriangle className="h-4 w-4" />} onClick={() => { setKind('other'); setSheet('issue'); }}>Report an issue</Button>
          <Button variant="glass" icon={<MessageSquarePlus className="h-4 w-4" />} onClick={() => setSheet('note')}>Add a note</Button>
        </div>
      )}

      <Sheet open={Boolean(sheet)} onClose={() => setSheet(null)} size="sm" title={sheet === 'issue' ? 'Report an issue' : sheet === 'note' ? 'Add a note' : 'Call not picked up'}
        description={sheet === 'unreached' ? 'The wash stays scheduled. Nothing is charged or completed.' : 'WASHO sees this straight away.'}
        footer={<Button full size="lg" loading={busy} disabled={sheet === 'note' && text.trim().length < 2 || sheet === 'issue' && kind !== 'customer_unavailable' && text.trim().length < 3} onClick={() => void submitSheet()}>{sheet === 'issue' ? 'Send to WASHO' : sheet === 'note' ? 'Save note' : 'Confirm not picked up'}</Button>}>
        <div className="space-y-4">
          {sheet === 'issue' && (
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Issue type">
              {ISSUES.map((i) => <button key={i.id} type="button" role="radio" aria-checked={kind === i.id} onClick={() => setKind(i.id)} className={`rounded-2xl border p-3 text-left text-sm font-semibold ${kind === i.id ? 'border-washo-400/60 bg-washo-500/15' : 'border-white/10 bg-white/[0.03]'}`}>{i.label}</button>)}
            </div>
          )}
          <TextArea label={sheet === 'note' ? 'Note' : 'Details'} optional={sheet !== 'note'} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder={sheet === 'unreached' ? 'Rang 3 times, no answer' : 'What happened?'} />
        </div>
      </Sheet>
    </div>
  );
}
