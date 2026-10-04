import type { SlotId } from './types';

// Slot windows. Crews start at the beginning of the window; the database uses the same start times.
export const SLOTS: { id: SlotId; label: string; window: string; icon: 'sunrise' | 'sun' | 'moon' }[] = [
  { id: 'morning', label: 'Morning', window: '7:00 – 11:00 AM', icon: 'sunrise' },
  { id: 'afternoon', label: 'Afternoon', window: '12:00 – 4:00 PM', icon: 'sun' },
  { id: 'night', label: 'Night', window: '7:00 – 10:00 PM', icon: 'moon' },
];

export const slotLabel = (id: SlotId): string => SLOTS.find((s) => s.id === id)?.label ?? id;
export const slotWindow = (id: SlotId): string => SLOTS.find((s) => s.id === id)?.window ?? '';
