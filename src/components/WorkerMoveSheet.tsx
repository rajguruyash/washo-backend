import { useState } from 'react';
import { cn } from '../lib/cn';
import { addDays, friendlyDay, todayIST } from '../lib/format';
import { useCapacity } from '../lib/queries';
import { slotLabel } from '../lib/slots';
import type { SlotId, WorkerWash } from '../lib/types';
import { DateSlotPicker } from './DateSlotPicker';
import { Button } from './ui/Button';
import { TextArea } from './ui/Field';
import { Sheet } from './ui/Sheet';

const REASONS = [
  { id: 'Car was not available', label: 'Car not available' },
  { id: 'Customer asked to move it', label: 'Customer asked' },
  { id: 'Other', label: 'Something else' },
] as const;

/**
 * The specialist moves a membership wash because the customer's vehicle is not available that day: to the next day with one tap, or to any
 * day they choose. The database applies the membership's rules (inside the term, not a day the vehicle already has a wash) and tells the
 * customer. A busy or rush day is flagged, not forbidden: WASHO's own crew decides.
 */
export function WorkerMoveSheet({ wash, onClose, onMove }: { wash: WorkerWash | null; onClose: () => void; onMove: (date: string, slot: SlotId, reason: string) => Promise<boolean> }) {
  // Mounted only while open, so the choices start fresh each time.
  return wash ? <MoveForm wash={wash} onClose={onClose} onMove={onMove} /> : null;
}

function MoveForm({ wash, onClose, onMove }: { wash: WorkerWash; onClose: () => void; onMove: (date: string, slot: SlotId, reason: string) => Promise<boolean> }) {
  const today = todayIST();
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<SlotId | null>(wash.time_slot);
  const [reason, setReason] = useState<(typeof REASONS)[number]['id']>(REASONS[0].id);
  const [note, setNote] = useState('');
  const [moving, setMoving] = useState(false);
  const crowd = useCapacity(today, addDays(today, 44)).data;

  // "Next day" is the day after the wash was due (never a day already gone).
  const base = wash.scheduled_date < today ? today : wash.scheduled_date;
  const quick = [addDays(base, 1), addDays(base, 2)];
  const state = date ? crowd?.[date]?.state : undefined;
  const text = [reason, note.trim()].filter((t) => t && t !== 'Other').join(': ') || 'Other';

  const submit = async () => {
    if (!date || !slot) return;
    setMoving(true);
    const ok = await onMove(date, slot, text);
    setMoving(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      locked={moving}
      size="lg"
      title="Move this wash"
      description={`Now ${friendlyDay(wash.scheduled_date)}, ${slotLabel(wash.time_slot)}. It stays with you on the new day, and the customer is told.`}
      footer={<Button full size="lg" disabled={!date || !slot} loading={moving} onClick={() => void submit()}>{date && slot ? `Move to ${friendlyDay(date)}, ${slotLabel(slot)}` : 'Choose a day'}</Button>}
    >
      <div className="space-y-6">
        <div>
          <p className="mb-2 text-[13px] font-medium text-mist">Quick pick</p>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Quick pick">
            {quick.map((d, i) => (
              <button key={d} type="button" aria-pressed={date === d} onClick={() => setDate(d)} className={cn('rounded-2xl border p-3.5 text-left transition-colors', date === d ? 'border-washo-400/70 bg-washo-500/15' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20')}>
                <span className="block text-sm font-bold">{i === 0 ? 'Next day' : 'Day after'}</span>
                <span className="block text-xs text-fog">{friendlyDay(d)}</span>
              </button>
            ))}
          </div>
        </div>

        <DateSlotPicker date={date} slot={slot} onDate={setDate} onSlot={setSlot} min={today} days={45} label="different day" />
        {state === 'busy' && <p className="-mt-2 rounded-2xl border border-warn/30 bg-warn/10 p-3 text-sm text-warn">That day is busy. You can still move it there.</p>}
        {state === 'full' && <p className="-mt-2 rounded-2xl border border-bad/30 bg-bad/10 p-3 text-sm text-bad">That day is a rush day (red). You can still move it there, but the crew will be stretched.</p>}

        <div>
          <p className="mb-2 text-[13px] font-medium text-mist">Why</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Why">
            {REASONS.map((r) => (
              <button key={r.id} type="button" role="radio" aria-checked={reason === r.id} onClick={() => setReason(r.id)} className={cn('rounded-2xl border p-3 text-center text-[13px] font-semibold transition-colors', reason === r.id ? 'border-washo-400/70 bg-washo-500/15' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20')}>{r.label}</button>
            ))}
          </div>
          <div className="mt-3"><TextArea label="Note for the customer" optional value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="For example: car was out of the society, will do it tomorrow morning" /></div>
        </div>
        <p className="text-xs text-fog">A membership wash can only move inside the membership, and not onto a day this vehicle already has a wash. If the membership ends before a suitable day, tell WASHO with Report an issue.</p>
      </div>
    </Sheet>
  );
}
