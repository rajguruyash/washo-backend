import { motion } from 'framer-motion';
import { ChevronRight, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/cn';
import { ApiError } from '../lib/http';
import { useHideWash } from '../lib/queries';
import { dayNumber, monthShort, prettyDate, weekdayShort } from '../lib/format';
import { slotLabel } from '../lib/slots';
import { customerStatus } from '../lib/status';
import type { Booking, BookingStatus, SlotId } from '../lib/types';
import { Plate } from './brand/Plate';
import { Badge } from './ui/Badge';
import { useToast } from './ui/Toast';
import SwipeRow from './reactbits/SwipeRow';
import { RatingStrip } from './WashRating';

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

/** The bookings a customer may clear from their own Washes tab: finished ones. (Nothing is deleted; the database refuses anything still coming up.) */
const CLEARABLE: BookingStatus[] = ['completed', 'cancelled', 'refunded', 'no_show'];

function WashRow({ booking, done }: { booking: Booking; done: boolean }) {
  return (
    <Link to={`/app/bookings/${booking.id}`} draggable={false} className="group flex items-center gap-4">
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
  );
}

/**
 * One wash in a list. A finished wash can be swiped away (React Bits Swipe Row) to clear it from the customer's own list, with Undo; a completed one carries five stars to rate it.
 * A wash that is still coming up is a plain card.
 */
export function BookingCard({ booking, index = 0, clearable = false }: { booking: Booking; index?: number; clearable?: boolean }) {
  const done = ['completed', 'cancelled', 'refunded', 'no_show'].includes(booking.status);
  const hide = useHideWash();
  const toast = useToast();
  if (clearable && CLEARABLE.includes(booking.status)) {
    const rateable = booking.status === 'completed';
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 8) * 0.04 }} className="mb-3">
        <SwipeRow
          label={`${booking.service_name} on ${prettyDate(booking.scheduled_date)}`}
          height={rateable ? 190 : 134}
          radius={24}
          rowColor="#0e1628"
          drawerColor="#1a2542"
          actionColor="#e5484d"
          className="rounded-3xl border border-white/[0.09] [&>div]:!rounded-3xl"
          actions={[{
            id: 'remove', label: 'Remove', icon: <Trash2 className="h-5 w-5" aria-hidden />,
            onSelect: () => {
              hide.mutateAsync({ id: booking.id })
                .then(() => toast.success('Removed from your list', { label: 'Undo', onClick: () => { hide.mutate({ id: booking.id, undo: true }); } }))
                .catch((err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove this. Please try again.'));
            },
          }]}
        >
          <div className="flex h-full min-w-0 flex-1 flex-col justify-center gap-2.5 py-3">
            <WashRow booking={booking} done={done} />
            {rateable && <RatingStrip wash={booking} className="border-t border-white/[0.07] pt-2" />}
          </div>
        </SwipeRow>
      </motion.div>
    );
  }
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 8) * 0.04 }} className="mb-3">
      <div className="glass p-4 transition-colors hover:border-washo-400/40"><WashRow booking={booking} done={done} /></div>
    </motion.div>
  );
}

/** "Mon + Wed + Fri" style label for a weekly pattern. */
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const patternLabel = (p: { weekday: number; kind: string }[]) =>
  [...p].sort((a, b) => a.weekday - b.weekday).map((x) => `${WEEKDAY_SHORT[x.weekday]} ${x.kind === 'deep' ? 'Deep' : 'Body'}`).join(' · ');
