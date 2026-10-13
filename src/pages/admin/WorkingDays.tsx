import { CalendarOff, CalendarPlus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { WEEKDAYS, fullDate, prettyDate, todayIST } from '../../lib/format';
import { useAdminAction, useAdminWorkingDays } from '../../lib/queries';
import { ConfirmSheet, Loading, errText } from './shared';

/** Monday first, like the calendars the customers see. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
const PRESETS = [
  { label: 'Every day', open: [0, 1, 2, 3, 4, 5, 6] },
  { label: 'Weekends only', open: [6, 0] },
  { label: 'Weekdays only', open: [1, 2, 3, 4, 5] },
] as const;
const sameSet = (a: number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));
const plural = (ids: number[]) => ids.map((id) => `${WEEKDAYS[id].long}s`).join(', ').replace(/, ([^,]*)$/, ' and $1');

/**
 * The days WASHO washes. Days of the week are on or off; single dates can be turned off (a holiday, bad weather) or on (a weekday WASHO will work after all). A closed day
 * stops customers booking a single wash on it, picking it for a membership, or moving a wash onto it, and the booking page tells them the next day they can book. An admin can
 * still book or move a wash onto a closed day. A wash already booked on a closed day stays booked until WASHO moves it: they are listed here.
 */
export default function WorkingDays({ canManage }: { canManage: boolean }) {
  const { data, isLoading, isError, error, refetch } = useAdminWorkingDays();
  const act = useAdminAction();
  const toast = useToast();
  const today = todayIST();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<'closed' | 'open'>('closed');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState('');
  const [confirmNone, setConfirmNone] = useState(false);

  if (isError) return <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />;
  if (isLoading || !data) return <Loading />;
  if (!data.installed) {
    return (
      <div className="glass space-y-2 p-6">
        <h2 className="text-lg font-bold">Working Days is not switched on yet</h2>
        <p className="max-w-2xl text-sm text-fog">The database needs one update first: migration 39 (<code className="rounded bg-white/10 px-1.5 py-0.5 text-xs">supabase/migrations/20261004000039_working_days.sql</code>). Paste it into the Supabase SQL Editor and run it. Until then every day is a working day.</p>
      </div>
    );
  }

  const openDays = data.weekdays.filter((w) => w.open).map((w) => w.weekday);
  const shutDays = WEEK.filter((d) => !openDays.includes(d));

  const saveWeekdays = async (next: number[]) => {
    try {
      await act.mutateAsync({ method: 'PUT', path: 'working-days/weekdays', body: { open_days: next } });
      toast.success(next.length === 7 ? 'WASHO now washes every day.' : next.length === 0 ? 'Every day is off.' : `WASHO now washes on ${plural(WEEK.filter((d) => next.includes(d)))}.`);
    } catch (err) { toast.error(errText(err)); }
  };
  const choose = (next: number[]) => (next.length === 0 ? setConfirmNone(true) : void saveWeekdays(next));
  const toggle = (id: number) => choose(openDays.includes(id) ? openDays.filter((d) => d !== id) : [...openDays, id]);

  const saveDates = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!from) return setFormError('Choose the date.');
    if (from < today) return setFormError('Choose today or a later date.');
    if (to && to < from) return setFormError('The last date cannot be before the first.');
    try {
      const r = await act.mutateAsync({ path: 'working-days/dates', body: { from, to: to || from, open: open === 'open', reason: reason.trim() || undefined } });
      toast.success(`${r.days} day${r.days === 1 ? '' : 's'} set as ${open === 'open' ? 'working' : 'closed'}.`);
      setFrom(''); setTo(''); setReason('');
    } catch (err) { setFormError(errText(err)); }
  };
  const clear = async (day: string) => {
    try { await act.mutateAsync({ method: 'DELETE', path: `working-days/dates/${day}` }); toast.success('That date follows its day of the week again.'); }
    catch (err) { toast.error(errText(err)); }
  };

  return (
    <div className="space-y-6">
      <section className="glass space-y-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Days of the week</h2>
            <p className="mt-1 max-w-3xl text-sm text-fog">
              Turn a day <strong className="text-white">off</strong> and customers cannot book a single wash on it, choose it for a membership, or move a wash onto it. They are told the next day they can book.
              It applies to single washes, memberships and free washes alike.
            </p>
          </div>
          {data.next_open && <Badge tone="blue">Next open day: {fullDate(data.next_open)}</Badge>}
        </div>

        <div className="grid grid-cols-7 gap-2" role="group" aria-label="Days of the week">
          {WEEK.map((id) => {
            const on = openDays.includes(id);
            return (
              <button
                key={id}
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${WEEKDAYS[id].long}: ${on ? 'on' : 'off'}`}
                disabled={!canManage || act.isPending}
                onClick={() => toggle(id)}
                className={cn(
                  'flex h-24 flex-col items-center justify-center gap-1 rounded-2xl border text-sm font-bold transition-all disabled:cursor-not-allowed disabled:opacity-60',
                  on ? 'border-ok/60 bg-ok/15 text-white shadow-[0_0_24px_-10px_rgb(52_211_153/0.7)]' : 'border-dashed border-white/15 bg-white/[0.02] text-white/45 hover:border-white/30'
                )}
              >
                {WEEKDAYS[id].short}
                <span className={cn('text-[10px] font-semibold uppercase', on ? 'text-ok' : 'text-fog')}>{on ? 'On' : 'Off'}</span>
              </button>
            );
          })}
        </div>

        <p className="text-sm">
          {openDays.length === 7 ? <span className="text-mist">WASHO washes every day. Nothing is turned off.</span>
            : openDays.length === 0 ? <span className="font-semibold text-bad">Every day is off: nobody can book anything.</span>
            : <span className="text-mist">WASHO washes on <strong className="text-white">{plural(WEEK.filter((d) => openDays.includes(d)))}</strong>. Closed: {plural(shutDays)}.</span>}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Quick choices">
          {PRESETS.map((p) => <Button key={p.label} size="sm" variant="glass" disabled={!canManage || act.isPending || sameSet(openDays, p.open)} onClick={() => choose([...p.open])}>{p.label}</Button>)}
        </div>
      </section>

      <section className="glass space-y-5 p-5">
        <div>
          <h2 className="text-lg font-bold">Specific dates</h2>
          <p className="mt-1 max-w-3xl text-sm text-fog">
            Close a date or a run of dates (a festival, heavy rain), or open a date on a day that is normally off. A date's own setting beats its day of the week.
            Washes already booked on a date you close stay booked until you move them.
          </p>
        </div>
        <form onSubmit={saveDates} className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end" noValidate>
          <Input label="From" type="date" min={today} value={from} onChange={(e) => setFrom(e.target.value)} disabled={!canManage} />
          <Input label="To" optional type="date" min={from || today} value={to} onChange={(e) => setTo(e.target.value)} disabled={!canManage} hint="Leave empty for one day" />
          <Segmented label="What this date is" value={open} onChange={setOpen} options={[{ value: 'closed', label: 'Closed' }, { value: 'open', label: 'Open' }]} />
          <Input className="md:col-span-2" label="Reason" optional value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} disabled={!canManage} placeholder="Diwali, heavy rain, team event" hint="Customers see it when they try to book that day" />
          <Button type="submit" loading={act.isPending} disabled={!canManage || !from} icon={open === 'closed' ? <CalendarOff className="h-4 w-4" /> : <CalendarPlus className="h-4 w-4" />}>{open === 'closed' ? 'Close' : 'Open'} {to && to !== from ? 'these dates' : 'this date'}</Button>
        </form>
        {formError && <p role="alert" className="text-sm text-bad">{formError}</p>}

        {data.dates.length === 0 ? (
          <p className="text-sm text-fog">No specific dates are set.</p>
        ) : (
          <ul className="panel divide-y divide-white/[0.07] overflow-hidden" aria-label="Dates that are set">
            {data.dates.map((d) => (
              <li key={d.day} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
                <div className="w-40 shrink-0"><p className="font-semibold">{prettyDate(d.day)}</p><p className="text-xs text-fog">{fullDate(d.day)}</p></div>
                <Badge tone={d.open ? 'green' : 'red'}>{d.open ? 'Open' : 'Closed'}</Badge>
                <p className="min-w-0 flex-1 truncate text-mist">{d.reason ?? <span className="text-fog">No reason given</span>}</p>
                {!d.open && d.washes > 0 && <Badge tone="amber">{d.washes} wash{d.washes === 1 ? '' : 'es'} booked</Badge>}
                {canManage && <Button size="sm" variant="glass" icon={<Trash2 className="h-4 w-4" />} disabled={act.isPending} onClick={() => void clear(d.day)} aria-label={`Remove the setting for ${fullDate(d.day)}`}>Remove</Button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.booked_on_closed.length > 0 && (
        <section className="glass space-y-3 border-warn/30 p-5">
          <div>
            <h2 className="text-lg font-bold">Washes booked on closed days</h2>
            <p className="mt-1 max-w-3xl text-sm text-fog">These are still booked. Move each one from the Washes tab (open the wash, Reschedule), or from the Paid tab. An admin can move a wash onto a closed day, so pick an open one.</p>
          </div>
          <ul className="panel divide-y divide-white/[0.07] overflow-hidden" aria-label="Washes booked on closed days">
            {data.booked_on_closed.map((b) => (
              <li key={b.date} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="font-semibold">{prettyDate(b.date)} <span className="font-normal text-fog">· {fullDate(b.date)}</span></span>
                <Badge tone="amber">{b.washes} wash{b.washes === 1 ? '' : 'es'}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmSheet
        open={confirmNone}
        onClose={() => setConfirmNone(false)}
        title="Turn every day off?"
        description="Nobody could book a single wash, start a membership or claim a free wash until a day is turned back on."
        confirmLabel="Turn every day off"
        tone="danger"
        loading={act.isPending}
        onConfirm={() => { void saveWeekdays([]).then(() => setConfirmNone(false)); }}
      />
    </div>
  );
}
