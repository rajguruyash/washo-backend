import { Moon, Sun, Sunrise } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '../lib/cn';
import { addDays, dayNumber, monthShort, todayIST, weekdayShort } from '../lib/format';
import { SLOTS } from '../lib/slots';
import type { SlotId } from '../lib/types';

const slotIcon = { sunrise: Sunrise, sun: Sun, moon: Moon };

/** A strip of dates (earliest `min`, up to `days` ahead, never past `max`) and the three daily windows. */
export function DateSlotPicker({
  date, slot, onDate, onSlot, min, max, days = 21, showSlot = true, label = 'date', disabledDates,
}: {
  date: string | null;
  slot: SlotId | null;
  onDate: (d: string) => void;
  onSlot?: (s: SlotId) => void;
  min: string;
  max?: string;
  days?: number;
  showSlot?: boolean;
  label?: string;
  /** Days that cannot be picked (fully booked), shown struck through. */
  disabledDates?: string[];
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

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-[13px] font-medium text-mist">Choose a {label}</p>
        <div role="radiogroup" aria-label={`Choose a ${label}`} className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {dates.map((d) => {
            const active = d === date;
            const full = disabledDates?.includes(d) ?? false;
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={active}
                aria-disabled={full || undefined}
                disabled={full}
                title={full ? 'Fully booked' : undefined}
                onClick={() => onDate(d)}
                className={cn(
                  'flex h-[76px] w-16 shrink-0 flex-col items-center justify-center rounded-2xl border transition-all',
                  full ? 'cursor-not-allowed border-white/[0.06] bg-white/[0.02] opacity-45' : active ? 'border-washo-400/70 bg-washo-500/20 shadow-[0_0_24px_-8px_rgb(63_124_255/0.8)]' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20'
                )}
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-fog">{d === today ? 'Today' : weekdayShort(d)}</span>
                <span className={cn('font-display text-xl font-extrabold leading-tight', full && 'line-through')}>{dayNumber(d)}</span>
                <span className="text-[10px] font-medium uppercase text-fog">{full ? 'Full' : monthShort(d)}</span>
              </button>
            );
          })}
        </div>
        {max && dates.length === 0 && <p className="mt-2 text-sm text-warn">There are no dates left to choose from.</p>}
      </div>

      {showSlot && onSlot && (
        <div>
          <p className="mb-2 text-[13px] font-medium text-mist">Choose a time window</p>
          <div role="radiogroup" aria-label="Choose a time window" className="grid gap-2 sm:grid-cols-3">
            {SLOTS.map((s) => {
              const Icon = slotIcon[s.icon];
              const active = s.id === slot;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onSlot(s.id)}
                  className={cn(
                    'flex items-center gap-3 rounded-2xl border p-3.5 text-left transition-all',
                    active ? 'border-washo-400/70 bg-washo-500/15' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20'
                  )}
                >
                  <span className={cn('grid h-10 w-10 place-items-center rounded-xl', active ? 'bg-washo-500 text-white' : 'bg-white/[0.07] text-washo-300')}><Icon className="h-5 w-5" /></span>
                  <span>
                    <span className="block text-sm font-bold">{s.label}</span>
                    <span className="block text-xs text-fog">{s.window}</span>
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
