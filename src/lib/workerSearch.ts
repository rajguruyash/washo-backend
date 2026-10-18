import type { PoolWash, WorkerWash } from './types';

/** Every word typed must appear somewhere in the fields (any case); a mobile number or plate matches however it was spaced. */
export function matchesAll(search: string, fields: (string | null | undefined)[]): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  const flat = hay.replace(/[\s-]/g, '');
  return words.every((w) => hay.includes(w) || flat.includes(w.replace(/[\s-]/g, '')));
}

/** What the specialist can search a wash of their own by. (A wash that is no longer theirs has its details hidden, so only the reference, service and day match.) */
export const queueFields = (w: WorkerWash, dayLabel: string): (string | null)[] => [
  w.reference_code, w.customer_name, w.customer_phone, w.registration_number, w.vehicle_make, w.vehicle_model, w.vehicle_color, w.vehicle_type,
  w.society_name, w.building_block, w.flat_number, w.area_locality, w.parking_location, w.service_name, w.membership_reference, dayLabel,
];

/** And an unclaimed wash by what is shown about it. */
export const poolFields = (p: PoolWash, dayLabel: string): (string | null | undefined)[] => [
  p.service_name, p.vehicle_type, p.vehicle_make, p.vehicle_model, p.vehicle_color, p.society_name, p.building_block, p.area_locality, p.city, p.parking_location, dayLabel,
];
