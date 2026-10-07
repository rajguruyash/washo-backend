import { Moon, Sun, Sunrise } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { cn } from '../lib/cn';
import { addDays, dayNumber, monthShort, todayIST, weekdayShort } from '../lib/format';
import { SLOTS } from '../lib/slots';
import type { CapacityDay, SlotId } from '../lib/types';

const slotIcon = { sunrise: Sunrise, sun: Sun, moon: Moon };

// When each window starts (Pune time): the same times the database uses to decide a booking is too soon.
const START_HOUR: Record<SlotId, number> = { morning: 7, afternoon: 12, night: 19 };
const startsAt = (date: string, slot: SlotId) => new Date(`${date}T${String(START_HOUR[slot]).padStart(2, '0')}:00:00+05:30`).getTime();

/** A strip of dates (earliest `min`, up to `days` ahead, never past `max`) and the three daily windows. */
export function DateSlotPicker({
  date, slot, onDate, onSlot, min, max, days = 21, showSlot = true, label = 'date', disabledDates, leadHours, crowd,
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
  /** How crowded each day and window is (Admin → Capacity): crowded days show amber, full days and windows are red and cannot be picked. */
  crowd?: Record<string, CapacityDay>;
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
  // crowd: a day is red only when nothing can be booked on it (every window is full); the windows say which ones are closed
  const dayFull = (d: string) => crowd?.[d]?.state === 'full';
  const noneLeft = dates.length > 0 && dates.every((d) => dayGone(d) || dayFull(d) || (disabledDates?.includes(d) ?? false));

  // A window chosen for one day may be too soon on another: drop it rather than let the booking be refused at the end.
  useEffect(() => {
    if (date && slot && onSlot && (tooSoon(date, slot) || crowd?.[date]?.slots[slot]?.state === 'full')) onSlot(null);
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
            const crowded = dayFull(d) && !active;
            const full = campaignFull || dayGone(d) || crowded;
            const soon = !campaignFull && !crowded && dayGone(d);
            const busy = !full && crowd?.[d]?.state === 'busy';
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={active}
                aria-disabled={full || undefined}
                disabled={full}
                title={soon ? `Needs ${leadHours} hours' notice` : full ? 'Fully booked' : busy ? 'Getting busy' : undefined}
                onClick={() => onDate(d)}
                className={cn(
                  'flex h-[76px] w-16 shrink-0 flex-col items-center justify-center rounded-2xl border transition-all',
                  crowded || (campaignFull && !soon) ? 'cursor-not-allowed border-bad/40 bg-bad/10' : full ? 'cursor-not-allowed border-white/[0.06] bg-white/[0.02] opacity-45'
                    : active ? 'border-washo-400/70 bg-washo-500/20 shadow-[0_0_24px_-8px_rgb(63_124_255/0.8)]'
                    : busy ? 'border-warn/50 bg-warn/10 hover:border-warn/80' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20'
                )}
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-fog">{d === today ? 'Today' : weekdayShort(d)}</span>
                <span className={cn('font-display text-xl font-extrabold leading-tight', full && 'line-through')}>{dayNumber(d)}</span>
                <span className={cn('text-[10px] font-semibold uppercase', crowded || campaignFull ? 'text-bad' : busy ? 'text-warn' : 'text-fog')}>{soon ? 'Soon' : full ? 'Full' : busy ? 'Busy' : monthShort(d)}</span>
              </button>
            );
          })}
        </div>
        {max && dates.length === 0 && <p className="mt-2 text-sm text-warn">There are no dates left to choose from.</p>}
        {noneLeft && <p className="mt-2 text-sm text-warn">No time is bookable in this range right now{leadHours ? `: a wash needs ${leadHours} hours' notice` : ''}.</p>}
        {showSlot && leadHours != null && leadHours >= 3 && !noneLeft && <p className="mt-2 text-xs text-fog">Bookings need at least {leadHours} hours' notice, so the soonest times are greyed out.</p>}
      </div>

      {showSlot && onSlot && (
        <div>
          <p className="mb-2 text-[13px] font-medium text-mist">Choose a time window</p>
          <div role="radiogroup" aria-label="Choose a time window" className="grid gap-2 sm:grid-cols-3">
            {SLOTS.map((s) => {
              const Icon = slotIcon[s.icon];
              const soon = Boolean(date) && tooSoon(date!, s.id);
              const cs = date ? crowd?.[date]?.slots[s.id]?.state : undefined;
              const closed = soon || cs === 'full';
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
                    cs === 'full' && !soon ? 'cursor-not-allowed border-bad/40 bg-bad/10' : soon ? 'cursor-not-allowed border-white/[0.06] bg-white/[0.02] opacity-45'
                      : active ? 'border-washo-400/70 bg-washo-500/15' : cs === 'busy' ? 'border-warn/50 bg-warn/10 hover:border-warn/80' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20'
                  )}
                >
                  <span className={cn('grid h-10 w-10 place-items-center rounded-xl', active ? 'bg-washo-500 text-white' : 'bg-white/[0.07] text-washo-300')}><Icon className="h-5 w-5" /></span>
                  <span>
                    <span className="block text-sm font-bold">{s.label}</span>
                    <span className={cn('block text-xs', cs === 'full' && !soon ? 'font-semibold text-bad' : cs === 'busy' && !soon ? 'font-semibold text-warn' : 'text-fog')}>{soon ? 'Too soon' : cs === 'full' ? 'Fully booked' : cs === 'busy' ? `Busy · ${s.window}` : s.window}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
