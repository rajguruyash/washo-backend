import type { VehicleType } from './types';

/** Money is held in paise (cents) everywhere; this renders rupees. */
export const rupees = (paise: number): string => {
  const value = paise / 100;
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })}`;
};

const parts = (date: string) => new Date(`${date}T00:00:00Z`);

/** "Sat, 12 Oct" */
export const dayLabel = (date: string): string =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(parts(date));

/** "12 Oct 2026" */
export const fullDate = (date: string): string =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(parts(date));

export const weekdayShort = (date: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'short' }).format(parts(date));
export const dayNumber = (date: string) => parts(date).getUTCDate();
export const monthShort = (date: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', month: 'short' }).format(parts(date));

export const todayIST = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export const addDays = (date: string, days: number): string => {
  const d = parts(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** "Today", "Tomorrow", or "Sat, 12 Oct" */
export const friendlyDay = (date: string): string => {
  const today = todayIST();
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return dayLabel(date);
};

/** MH12AB1234 → "MH 12 AB 1234" */
export const formatPlate = (reg: string): string => {
  const m = reg.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$/);
  if (m) return [m[1], m[2], m[3], m[4]].filter(Boolean).join(' ');
  const bh = reg.match(/^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/);
  if (bh) return `${bh[1]} ${bh[2]} ${bh[3]} ${bh[4]}`;
  return reg;
};

export const vehicleLabel: Record<VehicleType, string> = { bike: 'Bike', car: 'Car', suv: 'SUV' };

export const WEEKDAYS = [
  { id: 0, short: 'Sun', long: 'Sunday' },
  { id: 1, short: 'Mon', long: 'Monday' },
  { id: 2, short: 'Tue', long: 'Tuesday' },
  { id: 3, short: 'Wed', long: 'Wednesday' },
  { id: 4, short: 'Thu', long: 'Thursday' },
  { id: 5, short: 'Fri', long: 'Friday' },
  { id: 6, short: 'Sat', long: 'Saturday' },
];

export const duration = (minutes: number): string => {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
};

export const relativeTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
};

/** "Tomorrow · Mon, 5 Oct" for near dates, "Mon, 5 Oct" otherwise (year only when it isn't this year). */
export const prettyDate = (date: string): string => {
  const f = friendlyDay(date);
  const sameYear = date.slice(0, 4) === todayIST().slice(0, 4);
  const base = sameYear ? dayLabel(date) : `${dayLabel(date)} ${date.slice(0, 4)}`;
  return f === 'Today' || f === 'Tomorrow' ? `${f} · ${base}` : base;
};

/** "today", "tomorrow", or "on Mon, 5 Oct": reads naturally mid-sentence. */
export const inSentence = (date: string): string => {
  const f = friendlyDay(date);
  return f === 'Today' ? 'today' : f === 'Tomorrow' ? 'tomorrow' : `on ${f}`;
};

export const vehiclePlural: Record<VehicleType, string> = { bike: 'bikes', car: 'cars', suv: 'SUVs' };

export const percent = (bp: number): string => `${bp / 100}%`;

/** Stored discount labels read "3 washes a week"; the site says "per week". */
export const perWeekLabel = (label: string | null | undefined): string | undefined => label?.replace(/\ba week\b/, 'per week') ?? undefined;

/** "+91 98765 43210" from "+919876543210". */
export const prettyPhone = (p: string | null | undefined): string => {
  const m = (p ?? '').match(/^\+91(\d{5})(\d{5})$/);
  return m ? `+91 ${m[1]} ${m[2]}` : (p ?? '');
};
