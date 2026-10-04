import { useEffect, useState } from 'react';
import { addDays, prettyDate, todayIST } from '../lib/format';
import { ApiError } from '../lib/http';
import { useRescheduleWash } from '../lib/queries';
import { slotLabel } from '../lib/slots';
import type { SlotId } from '../lib/types';
import { DateSlotPicker } from './DateSlotPicker';
import { Button } from './ui/Button';
import { Sheet } from './ui/Sheet';
import { useToast } from './ui/Toast';

/** Move one membership wash. The database enforces the notice period, the membership term and one wash per vehicle per day. */
export function RescheduleSheet({ wash, endDate, onClose }: { wash: { id: string; scheduled_date: string; time_slot: SlotId } | null; endDate?: string; onClose: () => void }) {
  const move = useRescheduleWash();
  const toast = useToast();
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<SlotId | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setDate(null);
    setSlot(wash?.time_slot ?? null);
    setError('');
  }, [wash]);

  const submit = async () => {
    if (!wash || !date || !slot) return;
    setError('');
    try {
      await move.mutateAsync({ id: wash.id, date, time_slot: slot });
      toast.success(`Moved to ${prettyDate(date)}, ${slotLabel(slot)}`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not move this wash. Please try again.');
    }
  };

  return (
    <Sheet
      open={Boolean(wash)}
      onClose={onClose}
      title="Reschedule this wash"
      description={wash ? `Currently ${prettyDate(wash.scheduled_date)}, ${slotLabel(wash.time_slot)}. Your other washes stay as they are.` : undefined}
      size="lg"
      footer={<Button full size="lg" disabled={!date || !slot} loading={move.isPending} onClick={() => void submit()}>Move this wash</Button>}
    >
      <DateSlotPicker date={date} slot={slot} onDate={setDate} onSlot={setSlot} min={addDays(todayIST(), 2)} max={endDate} days={45} />
      {error && <p role="alert" className="mt-4 text-sm text-bad">{error}</p>}
    </Sheet>
  );
}
