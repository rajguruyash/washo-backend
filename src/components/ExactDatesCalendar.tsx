import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '../lib/cn';
import { RUSH_NOTE } from '../lib/crowd';
import { exactDatesProblem, weekKey, type Need } from '../lib/schedule';
import type { CapacityDay, ExactDate, SlotId, WashKind } from '../lib/types';

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthTitle = (y: number, m: number) => new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m, 1)));
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const longDay = (date: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

/**
 * Every wash of the membership on a calendar, picked by hand. Body washes are blue and Deep cleans yellow; choose a kind, then tap days.
 * Busy days are marked amber and rush days red (with a note about a slight delay), but any of them can be picked; nothing before the earliest start (not today or tomorrow) and
 * nothing after the term can be chosen; one wash a day; no more in a week than the plan's washes per week. The database checks all of it again before payment.
 */
export function ExactDatesCalendar({ start, end, minDate, need, perWeek, value, onChange, onReset, crowd, slot }: {
  start: string; end: string; minDate: string; need: Need; perWeek: number; value: ExactDate[]; onChange: (v: ExactDate[]) => void; onReset: () => void; crowd?: Record<string, CapacityDay>; slot: SlotId | null;
}) {
  const [mode, setMode] = useState<WashKind>(need.body > 0 ? 'body' : 'deep');
  const [note, setNote] = useState('');
  const kindOf = useMemo(() => new Map(value.map((v) => [v.date, v.kind])), [value]);
  const have = { body: value.filter((v) => v.kind === 'body').length, deep: value.filter((v) => v.kind === 'deep').length };
  const left = { body: need.body - have.body, deep: need.deep - have.deep };
  const perWeekCount = useMemo(() => { const m = new Map<string, number>(); for (const v of value) m.set(weekKey(v.date), (m.get(weekKey(v.date)) ?? 0) + 1); return m; }, [value]);
  const problem = exactDatesProblem({ value, need, perWeek, minDate, end });
  const stateOf = (date: string) => (slot ? crowd?.[date]?.slots[slot]?.state : crowd?.[date]?.state);
  const rushChosen = value.filter((v) => stateOf(v.date) === 'full').length;

  const months = useMemo(() => {
    const out: { y: number; m: number }[] = [];
    const s0 = new Date(`${start}T00:00:00Z`), e0 = new Date(`${end}T00:00:00Z`);
    let y = s0.getUTCFullYear(), m = s0.getUTCMonth();
    const ey = e0.getUTCFullYear(), em = e0.getUTCMonth();
    while (y < ey || (y === ey && m <= em)) {
      out.push({ y, m });
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
    return out;
  }, [start, end]);

  const pick = (date: string) => {
    setNote('');
    const current = kindOf.get(date);
    if (current) {
      if (current === mode) return onChange(value.filter((v) => v.date !== date)); // tap again to remove
      if (left[mode] > 0) return onChange(value.map((v) => (v.date === date ? { ...v, kind: mode } : v))); // switch its kind
      return onChange(value.filter((v) => v.date !== date));
    }
    if (left[mode] <= 0) {
      const other: WashKind = mode === 'body' ? 'deep' : 'body';
      if (left[other] > 0) { setMode(other); setNote(`You have chosen all your ${mode === 'body' ? 'Body washes' : 'Deep cleans'}. Now pick your ${other === 'body' ? 'Body washes' : 'Deep cleans'}.`); }
      else setNote('All your washes are placed. Tap a chosen day to move it.');
      return;
    }
    if ((perWeekCount.get(weekKey(date)) ?? 0) >= perWeek) { setNote(`No more than ${perWeek} wash${perWeek > 1 ? 'es' : ''} in one week.`); return; }
    onChange([...value, { date, kind: mode }]);
    if (left[mode] - 1 === 0 && left[mode === 'body' ? 'deep' : 'body'] > 0) setMode(mode === 'body' ? 'deep' : 'body');
  };

  const chip = (kind: WashKind, label: string) => (
    <button key={kind} type="button" aria-pressed={mode === kind} onClick={() => setMode(kind)} className={cn('flex-1 rounded-2xl border px-3 py-2.5 text-left transition-colors', mode === kind ? (kind === 'body' ? 'border-washo-400/70 bg-washo-500/20' : 'border-offer/60 bg-offer/15') : 'border-white/10 bg-white/[0.03] hover:border-white/20')}>
      <span className="flex items-center gap-2 text-sm font-bold"><span className={cn('h-2.5 w-2.5 rounded-full', kind === 'body' ? 'bg-washo-400' : 'bg-offer')} />{label}</span>
      <span className={cn('text-xs', left[kind] === 0 ? 'text-ok' : 'text-fog')}>{have[kind]} of {need[kind]} chosen</span>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="group" aria-label="Which kind of wash you are placing">
        {need.body > 0 && chip('body', 'Body washes')}
        {need.deep > 0 && chip('deep', 'Deep cleans')}
      </div>
      <p role="status" className={cn('min-h-5 text-sm', problem ? 'text-fog' : 'font-semibold text-ok')}>{note || problem || `All ${value.length} washes are placed. You can still move any of them.`}</p>

      {months.map(({ y, m }) => {
        const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
        const lead = (first + 6) % 7;
        const count = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        return (
          <section key={`${y}-${m}`} aria-label={monthTitle(y, m)} className="panel p-3 sm:p-4">
            <h3 className="mb-2 text-sm font-bold">{monthTitle(y, m)}</h3>
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold uppercase text-fog">{WEEK.map((w) => <span key={w}>{w}</span>)}</div>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
              {Array.from({ length: count }, (_, i) => {
                const date = iso(y, m, i + 1);
                const kind = kindOf.get(date);
                const out = date < minDate || date < start || date > end;
                const c = stateOf(date);
                const rush = !out && c === 'full';
                const busy = !out && c === 'busy';
                const disabled = out;
                return (
                  <button
                    key={date}
                    type="button"
                    disabled={disabled}
                    aria-pressed={Boolean(kind)}
                    aria-label={`${longDay(date)}${kind ? `, ${kind === 'body' ? 'Body wash' : 'Deep clean'}` : ''}${rush ? ', rush day, there might be a slight delay' : busy && !kind ? ', busy' : ''}${out ? ', not available' : ''}`}
                    onClick={() => pick(date)}
                    className={cn(
                      'relative grid aspect-square place-items-center rounded-xl border text-sm font-bold transition-colors',
                      kind === 'body' ? 'border-washo-400 bg-washo-500 text-white' : kind === 'deep' ? 'border-offer bg-offer text-ink-950' :
                      out ? 'cursor-not-allowed border-transparent text-white/20' :
                      rush ? 'border-bad/50 bg-bad/10 text-bad hover:border-bad' :
                      busy ? 'border-warn/50 bg-warn/10 hover:border-warn' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/25',
                      kind && rush && 'ring-2 ring-bad'
                    )}
                  >
                    {i + 1}
                    {busy && !kind && <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn" />}
                    {rush && !kind && <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-bad" />}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fog" aria-hidden>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-washo-500" /> Body wash</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-offer" /> Deep clean</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-warn/60 bg-warn/20" /> Busy day</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-bad/40 bg-bad/20" /> Rush day (slight delay possible)</span>
        <span>Greyed: before {longDay(minDate)} or after your membership ends</span>
      </div>
      {rushChosen > 0 && <p role="note" className="flex items-start gap-2 rounded-2xl border border-bad/30 bg-bad/10 p-3 text-sm text-bad"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {rushChosen === 1 ? 'One of your days is a rush day' : `${rushChosen} of your days are rush days`}. {RUSH_NOTE.replace('It is a rush on this day, so there', 'There')}</p>}
      <button type="button" onClick={onReset} className="inline-flex items-center gap-1.5 text-sm font-semibold text-washo-300 hover:text-white"><RotateCcw className="h-4 w-4" /> Back to the automatic spread</button>
    </div>
  );
}
