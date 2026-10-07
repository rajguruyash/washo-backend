import { useMemo, useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { Badge, type Tone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { addDays, prettyDate, todayIST } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useAdminAction, useAdminCapacity } from '../../lib/queries';
import type { CapacityDay, CapacityRule, CrowdState } from '../../lib/types';
import { Loading, errText } from './shared';

const STATE: Record<CrowdState, { label: string; tone: Tone; text: string; bar: string }> = {
  ok: { label: 'Room', tone: 'green', text: 'text-ok', bar: 'bg-ok' },
  busy: { label: 'Busy', tone: 'amber', text: 'text-warn', bar: 'bg-warn' },
  full: { label: 'Full', tone: 'red', text: 'text-bad', bar: 'bg-bad' },
};
const KINDS = [{ kind: 'weekday', title: 'Weekdays', sub: 'Monday to Friday' }, { kind: 'weekend', title: 'Weekends', sub: 'Saturday and Sunday' }] as const;
type Form = Record<'weekday' | 'weekend', Record<keyof Omit<CapacityRule, 'day_kind'>, string>>;

const toForm = (rules: CapacityRule[]): Form => {
  const f = (k: 'weekday' | 'weekend') => { const r = rules.find((x) => x.day_kind === k); return { day_busy: String(r?.day_busy ?? ''), day_full: String(r?.day_full ?? ''), slot_busy: String(r?.slot_busy ?? ''), slot_full: String(r?.slot_full ?? '') }; };
  return { weekday: f('weekday'), weekend: f('weekend') };
};

/** The two limits for a kind of day: when it turns busy (a warning) and when it is full (closed), for the whole day and for each time window. */
function Limits({ rules }: { rules: CapacityRule[] }) {
  const act = useAdminAction();
  const toast = useToast();
  const [f, setF] = useState<Form>(() => toForm(rules));
  const [errors, setErrors] = useState('');
  const set = (kind: 'weekday' | 'weekend', key: keyof Form['weekday']) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [kind]: { ...f[kind], [key]: e.target.value.replace(/\D/g, '') } });
  const num = (v: string) => Number(v);
  const changed = JSON.stringify(f) !== JSON.stringify(toForm(rules));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors('');
    const body = Object.fromEntries((['weekday', 'weekend'] as const).map((k) => [k, { day_busy: num(f[k].day_busy), day_full: num(f[k].day_full), slot_busy: num(f[k].slot_busy), slot_full: num(f[k].slot_full) }]));
    try {
      await act.mutateAsync({ method: 'PUT', path: 'capacity', body });
      toast.success('Limits saved. The booking pages use them now.');
    } catch (err) { setErrors(err instanceof ApiError ? err.message : errText(err)); }
  };
  return (
    <form onSubmit={save} className="glass space-y-5 p-5" noValidate>
      <div>
        <h2 className="text-lg font-bold">How many vehicles can you wash?</h2>
        <p className="mt-1 max-w-3xl text-sm text-fog">
          Every wash booked for a day counts: memberships, single washes and free washes. When a day or a time window reaches <strong className="text-warn">Busy</strong> customers see an amber warning; at <strong className="text-bad">Full</strong> it turns red and can no longer be picked.
          Washes you book yourself in the Washes tab are never blocked, and a membership that is already paid for is never refused because of this.
        </p>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        {KINDS.map((k) => (
          <fieldset key={k.kind} className="rounded-2xl border border-white/10 p-4">
            <legend className="px-2 text-sm font-bold">{k.title} <span className="font-normal text-fog">· {k.sub}</span></legend>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-fog">Whole day</p>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Busy from" inputMode="numeric" value={f[k.kind].day_busy} onChange={set(k.kind, 'day_busy')} hint="vehicles" />
              <Input label="Full at" inputMode="numeric" value={f[k.kind].day_full} onChange={set(k.kind, 'day_full')} hint="vehicles" />
            </div>
            <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-fog">Each time window (morning, afternoon, night)</p>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Busy from" inputMode="numeric" value={f[k.kind].slot_busy} onChange={set(k.kind, 'slot_busy')} hint="vehicles" />
              <Input label="Full at" inputMode="numeric" value={f[k.kind].slot_full} onChange={set(k.kind, 'slot_full')} hint="vehicles" />
            </div>
          </fieldset>
        ))}
      </div>
      {errors && <p role="alert" className="text-sm text-bad">{errors}</p>}
      <Button type="submit" loading={act.isPending} disabled={!changed}>Save limits</Button>
    </form>
  );
}

function Cell({ s, n }: { s: CrowdState; n: number }) {
  return <span className={cn('inline-flex min-w-9 justify-center rounded-lg px-2 py-1 text-sm font-semibold tabular-nums', s === 'ok' ? 'bg-white/[0.05] text-mist' : s === 'busy' ? 'bg-warn/15 text-warn' : 'bg-bad/15 text-bad')}>{n}</span>;
}

function Row({ d }: { d: CapacityDay }) {
  const st = STATE[d.state];
  return (
    <li className={cn('grid grid-cols-[7.5rem_1fr_auto] items-center gap-x-4 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[9rem_1fr_16rem_5rem]', d.state === 'full' && 'bg-bad/[0.06]')}>
      <div><p className="font-semibold">{prettyDate(d.date)}</p><p className="text-xs text-fog">{d.kind === 'weekend' ? 'Weekend' : 'Weekday'}</p></div>
      <div className="hidden sm:block">
        <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className={cn('h-full rounded-full', st.bar)} style={{ width: `${Math.min(100, (d.total / d.limit) * 100)}%` }} /></div>
        <p className="mt-1 text-xs text-fog"><span className={cn('font-semibold', st.text)}>{d.total}</span> of {d.limit} vehicles</p>
      </div>
      <div className="col-start-2 flex items-center justify-end gap-3 sm:col-start-auto sm:justify-between">
        {(['morning', 'afternoon', 'night'] as const).map((s) => <span key={s} className="flex flex-col items-center gap-0.5"><Cell s={d.slots[s].state} n={d.slots[s].n} /><span className="text-[10px] uppercase text-fog">{s.slice(0, 3)}</span></span>)}
      </div>
      <div className="col-start-3 row-start-1 justify-self-end sm:col-start-auto sm:row-start-auto"><Badge tone={st.tone}>{st.label}</Badge></div>
    </li>
  );
}

export default function Capacity() {
  const [span, setSpan] = useState<'14' | '28' | '60'>('28');
  const from = useMemo(() => todayIST(), []);
  const { data, isLoading, isError, error, refetch } = useAdminCapacity(from, addDays(from, Number(span) - 1));
  if (isError) return <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />;
  if (isLoading || !data) return <Loading />;
  const crowded = data.days.filter((d) => d.state !== 'ok').length;
  return (
    <div className="space-y-6">
      <Limits key={JSON.stringify(data.rules)} rules={data.rules} />
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-lg font-bold">The days ahead</h2><p className="text-sm text-fog">{crowded ? `${crowded} of the next ${span} days are busy or full.` : `Nothing is busy in the next ${span} days.`} Counts are vehicles booked in each time window.</p></div>
          <Segmented label="How far ahead" value={span} onChange={setSpan} options={[{ value: '14', label: '2 weeks' }, { value: '28', label: '4 weeks' }, { value: '60', label: '2 months' }]} />
        </div>
        <ul className="panel divide-y divide-white/[0.07] overflow-hidden">{data.days.map((d) => <Row key={d.date} d={d} />)}</ul>
      </section>
    </div>
  );
}
