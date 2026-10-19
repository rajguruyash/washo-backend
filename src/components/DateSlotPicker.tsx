import { AlertTriangle, Moon, Sun, Sunrise } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { cn } from '../lib/cn';
import { addDays, dayNumber, friendlyDay, monthShort, todayIST, weekdayShort } from '../lib/format';
import { SLOTS } from '../lib/slots';
import type { CapacityDay, SlotId } from '../lib/types';

const slotIcon = { sunrise: Sunrise, sun: Sun, moon: Moon };

// When each window starts (Pune time): the same times the database uses to decide a booking is too soon.
const START_HOUR: Record<SlotId, number> = { morning: 7, afternoon: 12, night: 19 };
const startsAt = (date: string, slot: SlotId) => new Date(`${date}T${String(START_HOUR[slot]).padStart(2, '0')}:00:00+05:30`).getTime();

/** A strip of dates (earliest `min`, up to `days` ahead, never past `max`) and the three daily windows. */
export function DateSlotPicker({
  date, slot, onDate, onSlot, min, max, days = 21, showSlot = true, label = 'date', disabledDates, leadHours, crowd, closedMode = 'block', fullMode = 'block',
}: {
  date: string | null;
  slot: SlotId | null;
  onDate: (d: string) => void;
  /** Called with null when the chosen window stops being bookable (the day changed to one where it is too soon). */
  onSlot?: (s: SlotId | null) => void;
  min: string;
  max?: string;
  days?: number;
  showSlot?: boolean;
  label?: string;
  /** Days that cannot be picked (fully booked), shown struck through. */
  disabledDates?: string[];
  /** Hours of notice a booking needs: windows that start sooner are greyed out, and so are days with no window left. */
  leadHours?: number;
  /** How crowded each day and window is (Admin → Capacity): busy ones show amber; full ones show red and (for customers) cannot be picked. */
  crowd?: Record<string, CapacityDay>;
  /**
   * Days WASHO is unavailable (Admin -> Working Days; they arrive in `crowd`). 'block' (customers, specialists): they cannot be picked and the page says when the next day
   * is. 'warn' (admins, who may always make an exception): they can be picked, with a note. 'ignore' (a membership's start day, which need not be a working day).
   * The same goes for a time window WASHO has turned off for a day (it arrives in `crowd` too, as `closed_slots`).
   */
  closedMode?: 'block' | 'warn' | 'ignore';
  /** A full day or time window (red in Admin -> Capacity). 'block' (customers, specialists): it cannot be picked and a short red message says so. 'warn' (admins): it can be picked, with a note. 'ignore': shown as busy (a membership's start day). */
  fullMode?: 'block' | 'warn' | 'ignore';
}) {
  const dates = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(min, i);
      if (max && d > max) break;
      out.push(d);
    }
    return out;
  }, [min, max, days]);
  const today = todayIST();
  const tooSoon = (d: string, s: SlotId) => leadHours != null && startsAt(d, s) < Date.now() + leadHours * 3_600_000;
  const dayGone = (d: string) => showSlot && leadHours != null && (['morning', 'afternoon', 'night'] as SlotId[]).every((s) => tooSoon(d, s));
  // crowd: a full window (red) cannot be picked (customers) or only warns (admins); amber (busy) is only a warning
  const slotIds = SLOTS.map((x) => x.id);
  const isFullSlot = (d: string, sl: SlotId) => fullMode === 'block' && crowd?.[d]?.slots[sl]?.state === 'full';
  // a time window WASHO has turned off on this day (Admin -> Working Days): greyed out and "Closed" for customers and specialists, a note for admins
  const shutSlotsOf = (d: string) => (closedMode === 'ignore' ? [] : crowd?.[d]?.closed_slots ?? []);
  const isShutSlot = (d: string, sl: SlotId) => closedMode === 'block' && shutSlotsOf(d).some((x) => x.slot === sl);
  const fullDay = (d: string) => (showSlot ? slotIds.every((sl) => isFullSlot(d, sl)) : fullMode === 'block' && crowd?.[d]?.state === 'full');
  // a day with no window left to pick: every window is full, too soon or turned off (a day whose windows are only too soon or turned off is shown as closed instead)
  const fullOrSoon = (d: string) => !dayGone(d) && showSlot && !windowsOff(d) && slotIds.every((sl) => tooSoon(d, sl) || isFullSlot(d, sl) || isShutSlot(d, sl));
  const dayFull = (d: string) => fullDay(d) || fullOrSoon(d);
  const closedOn = (d: string) => (closedMode !== 'ignore' && crowd?.[d]?.closed ? { reason: crowd[d].closed_reason ?? null } : null);
  // every window still to come that day is one WASHO has turned off (the rest have started): the day cannot be booked, and is shown as closed
  const windowsOff = (d: string) => showSlot && closedMode === 'block' && slotIds.some((sl) => isShutSlot(d, sl)) && slotIds.every((sl) => tooSoon(d, sl) || isShutSlot(d, sl));
  const closedBlocked = (d: string) => closedMode === 'block' && (closedOn(d) !== null || windowsOff(d));
  const noneLeft = dates.length > 0 && dates.every((d) => dayGone(d) || closedBlocked(d) || dayFull(d) || (disabledDates?.includes(d) ?? false));
  // the first day in this strip that can be picked, said to the customer when some days are closed
  const nextBookable = dates.find((d) => !dayGone(d) && !closedBlocked(d) && !dayFull(d) && !(disabledDates?.includes(d) ?? false));
  const closedCount = dates.filter((d) => closedBlocked(d)).length;
  const fullCount = dates.filter((d) => !closedBlocked(d) && dayFull(d)).length;
  const closedPicked = date ? closedOn(date) : null;
  // the windows of the chosen day that are full (only said to people who cannot pick them; an admin gets a note instead)
  const fullHere = date && showSlot ? SLOTS.filter((x) => crowd?.[date]?.slots[x.id]?.state === 'full') : [];
  const fullNote = fullMode === 'warn' && fullHere.length > 0;
  // the windows of the chosen day WASHO has turned off (and are not already too soon)
  const shutHere = date && showSlot ? SLOTS.filter((x) => shutSlotsOf(date).some((c) => c.slot === x.id) && !tooSoon(date, x.id)) : [];
  const shutNames = shutHere.map((x) => x.label).join(' and ');
  const shutWhy = [...new Set(shutHere.map((x) => (date ? shutSlotsOf(date).find((c) => c.slot === x.id)?.reason : null)).filter(Boolean))].join(', ');

  // A window chosen for one day may be too soon or full on another: drop it rather than let the booking be refused at the end.
  useEffect(() => {
    if (date && slot && onSlot && (tooSoon(date, slot) || isFullSlot(date, slot) || isShutSlot(date, slot))) onSlot(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, slot, leadHours, crowd]);

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-[13px] font-medium text-mist">Choose a {label}</p>
        <div role="radiogroup" aria-label={`Choose a ${label}`} className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {dates.map((d) => {
            const active = d === date;
            const campaignFull = disabledDates?.includes(d) ?? false;
            const closed = closedOn(d);
            const shut = closedBlocked(d);
            const isFullDay = !shut && dayFull(d);
            const full = campaignFull || dayGone(d) || shut || isFullDay;
            const soon = !campaignFull && !shut && !isFullDay && dayGone(d);
            const rush = !full && !closed && fullMode === 'warn' && crowd?.[d]?.state === 'full';
            const busy = !full && !closed && (crowd?.[d]?.state === 'busy' || (fullMode === 'ignore' && crowd?.[d]?.state === 'full'));
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={active}
                aria-disabled={full || undefined}
                disabled={full}
                title={isFullDay ? 'Fully booked' : shut ? (closed?.reason ? `Closed: ${closed.reason}` : 'WASHO is currently unavailable on this day') : closed ? `WASHO is currently unavailable on this day${closed.reason ? ` (${closed.reason})` : ''}` : soon ? `Needs ${leadHours} hours' notice` : full ? 'Fully booked' : rush ? 'Rush: there might be a slight delay' : busy ? 'Getting busy' : undefined}
                onClick={() => onDate(d)}
                className={cn(
                  'flex h-[76px] w-16 shrink-0 flex-col items-center justify-center rounded-2xl border transition-all',
                  (campaignFull && !soon && !shut) || isFullDay ? 'cursor-not-allowed border-bad/40 bg-bad/10' : full ? 'cursor-not-allowed border-white/[0.06] bg-white/[0.02] opacity-45'
                    : rush ? (active ? 'border-bad bg-bad/25 shadow-[0_0_24px_-8px_rgb(255_107_122/0.8)]' : 'border-bad/50 bg-bad/10 hover:border-bad/80')
                    : active ? 'border-washo-400/70 bg-washo-500/20 shadow-[0_0_24px_-8px_rgb(63_124_255/0.8)]'
                    : closed ? (active ? 'border-warn bg-warn/20' : 'border-dashed border-warn/50 bg-warn/[0.07] hover:border-warn')
                    : busy ? 'border-warn/50 bg-warn/10 hover:border-warn/80' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20'
                )}
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-fog">{d === today ? 'Today' : weekdayShort(d)}</span>
                <span className={cn('font-display text-xl font-extrabold leading-tight', full && 'line-through')}>{dayNumber(d)}</span>
                <span className={cn('text-[10px] font-semibold uppercase', rush || isFullDay || (campaignFull && !shut) ? 'text-bad' : busy || closed ? 'text-warn' : 'text-fog')}>{shut || closed ? 'Closed' : soon ? 'Soon' : full ? 'Full' : rush ? 'Full' : busy ? 'Busy' : monthShort(d)}</span>
              </button>
            );
          })}
        </div>
        {closedCount > 0 && !noneLeft && (
          <p role="note" className="mt-2 text-sm text-warn">
            WASHO is currently unavailable on these days.{nextBookable ? ` The next day you can book is ${friendlyDay(nextBookable)}.` : ''}
          </p>
        )}
        {fullCount > 0 && !noneLeft && <p role="note" className="mt-2 text-sm font-semibold text-bad">Days marked Full are fully booked. Please choose another day.</p>}
        {closedMode === 'warn' && closedPicked && <p role="note" className="mt-2 text-sm text-warn">WASHO is currently unavailable that day{closedPicked.reason ? ` (${closedPicked.reason})` : ''}. You can still book it as an admin.</p>}
        {max && dates.length === 0 && <p className="mt-2 text-sm text-warn">There are no dates left to choose from.</p>}
        {noneLeft && <p className="mt-2 text-sm text-warn">{closedCount > 0 ? 'WASHO is currently unavailable on all of these days. Please look at a later week.' : fullCount > 0 ? 'Every day shown is fully booked. Please look at a later week.' : `No time is bookable in this range right now${leadHours ? `: a wash needs ${leadHours} hours' notice` : ''}.`}</p>}
        {showSlot && leadHours != null && leadHours >= 3 && !noneLeft && <p className="mt-2 text-xs text-fog">Bookings need at least {leadHours} hours' notice, so the soonest times are greyed out.</p>}
      </div>

      {showSlot && onSlot && (
        <div>
          <p className="mb-2 text-[13px] font-medium text-mist">Choose a time window</p>
          <div role="radiogroup" aria-label="Choose a time window" className="grid gap-2 sm:grid-cols-3">
            {SLOTS.map((s) => {
              const Icon = slotIcon[s.icon];
              const soon = Boolean(date) && tooSoon(date!, s.id);
              const raw = date ? crowd?.[date]?.slots[s.id]?.state : undefined;
              const cs = raw === 'full' && fullMode === 'ignore' ? 'busy' : raw;
              const isFull = isFullSlot(date ?? '', s.id);
              const isShut = date ? shutSlotsOf(date).some((c) => c.slot === s.id) : false;
              const shut = isShut && closedMode === 'block';
              const closed = soon || isFull || shut;
              const active = s.id === slot && !closed;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-disabled={closed || undefined}
                  disabled={closed}
                  onClick={() => onSlot(s.id)}
                  className={cn(
                    'flex items-center gap-3 rounded-2xl border p-3.5 text-left transition-all',
                    soon ? 'cursor-not-allowed border-white/[0.06] bg-white/[0.02] opacity-45'
                      : shut ? 'cursor-not-allowed border-warn/30 bg-warn/[0.05] opacity-70'
                      : isFull ? 'cursor-not-allowed border-bad/40 bg-bad/10 opacity-80'
                      : isShut ? (active ? 'border-warn bg-warn/20' : 'border-dashed border-warn/50 bg-warn/[0.07] hover:border-warn')
                      : cs === 'full' ? (active ? 'border-bad bg-bad/20' : 'border-bad/50 bg-bad/10 hover:border-bad/80')
                      : active ? 'border-washo-400/70 bg-washo-500/15' : cs === 'busy' ? 'border-warn/50 bg-warn/10 hover:border-warn/80' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20'
                  )}
                >
                  <span className={cn('grid h-10 w-10 place-items-center rounded-xl', active ? 'bg-washo-500 text-white' : 'bg-white/[0.07] text-washo-300')}><Icon className="h-5 w-5" /></span>
                  <span>
                    <span className="block text-sm font-bold">{s.label}</span>
                    <span className={cn('block text-xs', isShut && !soon ? 'font-semibold text-warn' : cs === 'full' && !soon ? 'font-semibold text-bad' : cs === 'busy' && !soon ? 'font-semibold text-warn' : 'text-fog')}>{soon ? 'Too soon' : isShut ? 'Closed' : cs === 'full' ? 'Full' : cs === 'busy' ? `Busy · ${s.window}` : s.window}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {closedMode === 'block' && shutHere.length > 0 && <p role="note" className="text-sm text-warn">WASHO is currently unavailable in the {shutNames} window{shutHere.length === 1 ? '' : 's'} that day{shutWhy ? ` (${shutWhy})` : ''}. Please choose another time{shutHere.length >= SLOTS.length ? ' or day' : ''}.</p>}
      {closedMode === 'warn' && shutHere.length > 0 && <p role="note" className="text-sm text-warn">{shutNames} {shutHere.length === 1 ? 'is' : 'are'} turned off that day{shutWhy ? ` (${shutWhy})` : ''}. You can still book it as an admin.</p>}
      {fullMode === 'block' && fullHere.length > 0 && !fullHere.every((x) => tooSoon(date!, x.id)) && (
        <p role="alert" className="flex items-start gap-2 text-sm font-semibold text-bad"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {fullHere.map((x) => x.label).join(' and ')} {fullHere.length === 1 ? 'is' : 'are'} full. Please choose another time{fullHere.length === 3 ? ' or day' : ''}.</p>
      )}
      {fullNote && <p role="note" className="flex items-start gap-2 text-sm text-bad"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {fullHere.map((x) => x.label).join(' and ')} {fullHere.length === 1 ? 'is' : 'are'} full. You can still book it as an admin.</p>}
    </div>
  );
}
