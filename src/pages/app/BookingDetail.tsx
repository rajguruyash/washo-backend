import { ArrowLeft, CalendarClock, CalendarPlus, MapPin, Scissors, Undo2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Plate } from '../../components/brand/Plate';
import { ErrorState } from '../../components/EmptyState';
import { PhotoGrid } from '../../components/PhotoGrid';
import { RescheduleSheet } from '../../components/RescheduleSheet';
import { CustomerStatus } from '../../components/WashBits';
import { Button } from '../../components/ui/Button';
import TearTicket from '../../components/reactbits/TearTicket';
import { Sheet } from '../../components/ui/Sheet';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { formatPlate, prettyDate, rupees } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { downloadBookingIcs } from '../../lib/ics';
import { useBooking, useCancelBooking } from '../../lib/queries';
import { slotLabel, slotWindow } from '../../lib/slots';
import { isLive } from '../../lib/status';

const eventText: Record<string, string> = {
  booking_created: 'Wash scheduled',
  worker_assigned: 'Specialist assigned',
  worker_called: 'Specialist called you',
  customer_confirmed: 'You confirmed with the specialist',
  call_not_picked_up: 'Specialist could not reach you. They will try again.',
  wash_started: 'Wash started',
  wash_completed: 'Wash completed',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
  refund_requested: 'Refund requested',
  refunded: 'Refunded',
};

const refundText = (status: string, amount: string) => {
  switch (status) {
    case 'processed':
      return { title: `${amount} refunded`, body: 'Sent back to the payment method you used. Your bank usually shows it within 5 to 7 working days.' };
    case 'approved':
      return { title: `Refund of ${amount} approved`, body: 'It is on its way to the payment method you used.' };
    default: // requested, or failed and waiting for WASHO to retry
      return { title: `Refund of ${amount} requested`, body: 'The full amount goes back to the payment method you used once WASHO approves it. You do not need to do anything.' };
  }
};

export default function BookingDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { data, isLoading, isError, refetch } = useBooking(id);
  const cancel = useCancelBooking();
  const [moving, setMoving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [ticketKey, setTicketKey] = useState(0); // a fresh, untorn ticket if the cancellation did not go through

  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !data) return <div className="space-y-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;
  const { booking: b, events, refund } = data;
  const live = isLive(b.status);
  const isMembership = b.booking_type === 'membership';

  // The ticket is torn by hand; only then is the booking cancelled. If the cancellation is refused, the ticket is replaced so it can be torn again.
  const doCancel = async () => {
    try {
      await cancel.mutateAsync({ id: b.id });
      toast.success(b.price_cents ? `Booking cancelled. Your full ${rupees(b.price_cents)} will be refunded once WASHO approves it.` : 'Booking cancelled.');
      setTimeout(() => setCancelling(false), 700);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not cancel this booking.');
      setTicketKey((k) => k + 1);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <Link to={b.membership_id ? `/app/membership/${b.membership_id}` : '/app/bookings'} className="mb-5 inline-flex items-center gap-1.5 text-sm text-fog hover:text-white"><ArrowLeft className="h-4 w-4" /> Back</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div><p className="eyebrow">{b.reference_code}</p><h1 className="mt-1 text-3xl font-extrabold">{b.service_name}</h1></div>
        <CustomerStatus status={b.status} />
      </div>

      <div className="glass divide-y divide-white/[0.07]">
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <div><p className="eyebrow">When</p><p className="mt-1 font-semibold">{prettyDate(b.scheduled_date)}</p><p className="text-xs text-fog">{slotLabel(b.time_slot)} · {slotWindow(b.time_slot)}</p></div>
          <div><p className="eyebrow">Vehicle</p><div className="mt-1.5 flex items-center gap-3"><span className="font-semibold">{b.vehicle_model}</span><Plate reg={b.registration_number} /></div></div>
          {b.parking_location && <div className="sm:col-span-2"><p className="eyebrow">Parking</p><p className="mt-1 flex items-center gap-2 text-sm"><MapPin className="h-4 w-4 text-washo-300" /> {b.parking_location}</p></div>}
          {b.price_cents != null && <div><p className="eyebrow">Paid</p><p className="mt-1 font-semibold">{rupees(b.price_cents)}</p></div>}
          {isMembership && b.membership_id && <div><p className="eyebrow">Membership</p><Link to={`/app/membership/${b.membership_id}`} className="mt-1 inline-block text-sm font-semibold text-washo-300 hover:text-white">View membership</Link></div>}
        </div>
        {b.cancel_reason && <div className="p-5"><p className="eyebrow">Cancellation reason</p><p className="mt-1 text-sm">{b.cancel_reason}</p></div>}
      </div>

      {refund && (
        <div className="glass mt-5 flex items-start gap-3 p-5">
          <Undo2 className="mt-0.5 h-5 w-5 shrink-0 text-washo-300" />
          <div><p className="font-semibold">{refundText(refund.status, rupees(refund.amount_cents)).title}</p><p className="mt-1 text-sm text-fog">{refundText(refund.status, rupees(refund.amount_cents)).body}</p></div>
        </div>
      )}

      {live && (
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <Button variant="ghost" icon={<CalendarPlus className="h-4 w-4" />} onClick={() => downloadBookingIcs(b)}>Add to calendar</Button>
          {b.status !== 'in_progress' && isMembership && b.occurrence_id && <Button variant="glass" icon={<CalendarClock className="h-4 w-4" />} onClick={() => setMoving(true)}>Reschedule</Button>}
          {b.status !== 'in_progress' && !isMembership && <Button variant="danger" icon={<XCircle className="h-4 w-4" />} onClick={() => setCancelling(true)}>Cancel booking</Button>}
        </div>
      )}
      {isMembership && live && <p className="mt-3 text-xs text-fog">Membership washes can be rescheduled but not cancelled.</p>}

      {b.status === 'completed' && <section className="mt-8"><h2 className="mb-3 text-lg font-bold">Before and after</h2><PhotoGrid bookingId={b.id} /></section>}

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-bold">Timeline</h2>
        <ol className="space-y-3 border-l border-white/10 pl-5">
          {events.map((e, i) => (
            <li key={i} className="relative">
              <span className="absolute -left-[1.62rem] top-1.5 h-2.5 w-2.5 rounded-full bg-washo-400" />
              <p className="text-sm font-semibold">{eventText[e.event_type] ?? e.event_type}</p>
              <p className="text-xs text-fog">{new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(e.created_at))}{e.event_type === 'rescheduled' && e.meta.new_date ? ` · to ${prettyDate(e.meta.new_date)}` : ''}</p>
            </li>
          ))}
        </ol>
      </section>

      <RescheduleSheet wash={moving ? { id: b.id, scheduled_date: b.scheduled_date, time_slot: b.time_slot } : null} onClose={() => setMoving(false)} />
      <Sheet open={cancelling} onClose={() => setCancelling(false)} locked={cancel.isPending} title="Cancel this booking?" description={b.price_cents ? `Tear off the stub to cancel. You will get the full ${rupees(b.price_cents)} back on the payment method you used, once WASHO approves the refund.` : 'Tear off the stub to cancel.'} size="sm" footer={<Button variant="glass" full disabled={cancel.isPending} onClick={() => setCancelling(false)}>Keep my booking</Button>}>
        <div className="grid select-none place-items-center py-2" onMouseDown={(e) => e.preventDefault() /* pulling the stub must not start selecting the text around it */}>
          <TearTicket
            key={ticketKey}
            orientation="vertical"
            width={300}
            height={400}
            stubSize={100}
            background="#111a2f"
            color="#f5f8ff"
            ariaLabel="Tear off the stub to cancel this booking"
            onTear={() => void doCancel()}
            stub={<div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-white/80"><Scissors className="h-5 w-5 text-washo-300" aria-hidden />Tear to cancel<span className="text-[10px] font-medium normal-case tracking-normal text-white/50">pull the stub down, or press Enter</span></div>}
          >
            <div className="flex h-full flex-col justify-between p-6">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-washo-300">{b.reference_code}</p>
                <p className="mt-2 text-2xl font-extrabold leading-tight">{b.service_name}</p>
              </div>
              <dl className="space-y-3 text-sm">
                <div><dt className="text-[11px] uppercase tracking-[0.16em] text-white/50">When</dt><dd className="mt-0.5 font-semibold">{prettyDate(b.scheduled_date)} · {slotLabel(b.time_slot)}</dd></div>
                <div><dt className="text-[11px] uppercase tracking-[0.16em] text-white/50">Vehicle</dt><dd className="mt-0.5 font-semibold">{b.vehicle_model} · {formatPlate(b.registration_number)}</dd></div>
                {b.price_cents != null && <div><dt className="text-[11px] uppercase tracking-[0.16em] text-white/50">Refunded in full</dt><dd className="mt-0.5 font-semibold">{rupees(b.price_cents)}</dd></div>}
              </dl>
            </div>
          </TearTicket>
        </div>
      </Sheet>
    </div>
  );
}
