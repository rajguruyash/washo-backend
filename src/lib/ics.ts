import { slotLabel, slotWindow } from './slots';
import type { Booking, SlotId } from './types';

const START: Record<SlotId, [number, number]> = { morning: [7, 11], afternoon: [12, 16], night: [19, 22] };
const stamp = (date: string, hour: number) => `${date.replace(/-/g, '')}T${String(hour).padStart(2, '0')}0000`;

/** Downloads a one-event calendar file for a wash (IST times, so any calendar app shows 7am as 7am). */
export function downloadBookingIcs(b: Booking) {
  const [start, end] = START[b.time_slot];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WASHO//Booking//EN',
    'BEGIN:VEVENT',
    `UID:${b.reference_code}@washo.online`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;TZID=Asia/Kolkata:${stamp(b.scheduled_date, start)}`,
    `DTEND;TZID=Asia/Kolkata:${stamp(b.scheduled_date, end)}`,
    `SUMMARY:WASHO · ${b.service_name}`,
    `DESCRIPTION:Wash ${b.reference_code}. ${b.vehicle_model} (${b.registration_number}). Crew arrives ${slotLabel(b.time_slot)}, ${slotWindow(b.time_slot)}.`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `washo-${b.reference_code}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
