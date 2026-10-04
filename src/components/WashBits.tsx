import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/cn';
import { dayNumber, monthShort, prettyDate, weekdayShort } from '../lib/format';
import { slotLabel } from '../lib/slots';
import { customerStatus } from '../lib/status';
import type { Booking, BookingStatus, SlotId } from '../lib/types';
import { Plate } from './brand/Plate';
import { Badge } from './ui/Badge';

export function DateTile({ date, dim }: { date: string; dim?: boolean }) {
  return (
    <div className={cn('flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-2xl border', dim ? 'border-white/10 bg-white/[0.04] opacity-70' : 'border-washo-500/30 bg-washo-500/10')}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-fog">{weekdayShort(date)}</span>
      <span className="font-display text-xl font-extrabold leading-tight">{dayNumber(date)}</span>
      <span className="text-[10px] font-medium uppercase text-fog">{monthShort(date)}</span>
    </div>
  );
}

export function CustomerStatus({ status }: { status: BookingStatus }) {
  const m = customerStatus[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function BookingCard({ booking, index = 0 }: { booking: Booking; index?: number }) {
  const done = ['completed', 'cancelled', 'refunded', 'no_show'].includes(booking.status);
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 8) * 0.04 }}>
      <Link to={`/app/bookings/${booking.id}`} className="glass group flex items-center gap-4 p-4 transition-colors hover:border-washo-400/40">
        <DateTile date={booking.scheduled_date} dim={done} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-bold">{booking.service_name}</p>
            {booking.booking_type === 'membership' && <Badge tone="blue">Membership</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-fog">{prettyDate(booking.scheduled_date)} · {slotLabel(booking.time_slot as SlotId)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Plate reg={booking.registration_number} />
            <CustomerStatus status={booking.status} />
          </div>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-fog transition-transform group-hover:translate-x-0.5" />
      </Link>
    </motion.div>
  );
}

/** "Mon + Wed + Fri" style label for a weekly pattern. */
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const patternLabel = (p: { weekday: number; kind: string }[]) =>
  [...p].sort((a, b) => a.weekday - b.weekday).map((x) => `${WEEKDAY_SHORT[x.weekday]} ${x.kind === 'deep' ? 'Deep' : 'Body'}`).join(' · ');
