import { CalendarClock, Pencil, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DateSlotPicker } from '../../components/DateSlotPicker';
import { PhotoGrid } from '../../components/PhotoGrid';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select, TextArea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { prettyDate, prettyPhone, rupees, todayIST } from '../../lib/format';
import { useAdminAction, useAdminBooking, useAdminCustomer, useAdminWorkers } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { staffStatus } from '../../lib/status';
import type { SlotId } from '../../lib/types';
import { Loading, errText } from './shared';

/** One wash in full: who, where, photos, history; and the admin's actions on it (assign, edit details, move, cancel). */
export function BookingSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data } = useAdminBooking(id ?? undefined);
  const workers = useAdminWorkers();
  const act = useAdminAction();
  const toast = useToast();
  const [view, setView] = useState<'details' | 'move' | 'cancel' | 'edit'>('details');
  const [addrId, setAddrId] = useState('');
  const [parking, setParking] = useState('');
  const [note, setNote] = useState('');
  const customer = useAdminCustomer(data?.booking.customer_id);
  const [worker, setWorker] = useState('');
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<SlotId | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { setView('details'); setWorker(''); setDate(null); setSlot(null); setReason(''); }, [id]);
  const b = data?.booking;
  useEffect(() => { if (b) { setAddrId(b.address_id ?? ''); setParking(b.parking_location ?? ''); setNote(b.notes ?? ''); } }, [b?.id, b?.address_id, b?.parking_location, b?.notes]);
  const run = async (path: string, body: Record<string, unknown>, ok: string, method: 'POST' | 'PUT' = 'POST') => {
    try { await act.mutateAsync({ path, body, method }); toast.success(ok); setView('details'); } catch (e) { toast.error(errText(e)); }
  };
  const live = b && ['confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up'].includes(b.status);

  return (
    <Sheet open={Boolean(id)} onClose={onClose} size="lg" title={b ? `${b.reference_code} · ${b.service_name}` : 'Wash'} description={b ? `${prettyDate(b.scheduled_date)}, ${slotLabel(b.time_slot)}` : undefined}>
      {!b ? <Loading /> : view === 'details' ? (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2"><Badge tone={staffStatus[b.status].tone}>{staffStatus[b.status].label}</Badge>{b.booking_type === 'membership' && <Badge tone="blue">Membership</Badge>}{b.source === 'admin' && <Badge>Booked by WASHO</Badge>}{b.customer_confirmed_at && <Badge tone="green">Customer confirmed</Badge>}</div>
          <div className="grid gap-4 text-sm sm:grid-cols-2">
            <div><p className="eyebrow">Customer</p><p className="font-semibold">{b.customer_name}</p><a href={`tel:${b.customer_phone}`} className="text-washo-300">{prettyPhone(b.customer_phone)}</a></div>
            <div><p className="eyebrow">Vehicle</p><p>{b.vehicle_type.toUpperCase()} · {b.vehicle_model} {b.vehicle_color ?? ''}</p><p className="text-fog">{b.registration_number}</p></div>
            <div><p className="eyebrow">Address</p><p>{[b.society_name, b.building_block, b.flat_number].filter(Boolean).join(', ')}</p><p className="text-fog">{b.parking_location}</p></div>
            <div><p className="eyebrow">Specialist</p><p className="font-semibold">{b.worker_name ?? 'Unassigned'}</p></div>
            {b.booking_type !== 'membership' && b.price_cents != null && <div><p className="eyebrow">Payment</p><p className="font-semibold">{b.price_cents === 0 ? 'Complimentary' : rupees(b.price_cents)}</p></div>}
            {b.notes && <div><p className="eyebrow">Note</p><p>{b.notes}</p></div>}
          </div>
          {live && (
            <div className="space-y-3 rounded-2xl border border-white/10 p-4">
              <Select label="Assign specialist" value={worker} onChange={(e) => setWorker(e.target.value)}>
                <option value="">Choose…</option>
                {workers.data?.map((w) => <option key={w.id} value={w.id}>{w.full_name} · {w.washes_next_7_days} washes this week</option>)}
              </Select>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!worker} loading={act.isPending} onClick={() => void run(`bookings/${b.id}/assign`, { worker_profile_id: worker }, 'Assigned')}>Assign</Button>
                {b.booking_type === 'membership' && <Button size="sm" variant="glass" icon={<CalendarClock className="h-4 w-4" />} onClick={() => setView('move')}>Reschedule</Button>}
                <Button size="sm" variant="glass" icon={<Pencil className="h-4 w-4" />} onClick={() => setView('edit')}>Edit details</Button>
                <Button size="sm" variant="danger" icon={<XCircle className="h-4 w-4" />} onClick={() => setView('cancel')}>Cancel wash</Button>
              </div>
            </div>
          )}
          <section><h3 className="mb-2 text-sm font-bold">Photos</h3><PhotoGrid bookingId={b.id} /></section>
          <section>
            <h3 className="mb-2 text-sm font-bold">History</h3>
            <ol className="space-y-2 text-sm">
              {data!.events.map((e, i) => (
                <li key={i} className="panel p-3">
                  <p className="font-semibold">{e.event_type.replace(/_/g, ' ')}{e.actor_name ? <span className="font-normal text-fog"> · {e.actor_name} ({e.actor_role})</span> : null}</p>
                  <p className="text-xs text-fog">{new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(e.created_at))}</p>
                  {(e.meta.notes || e.meta.note || e.meta.reason || e.meta.kind) && <p className="mt-1 text-mist">{[e.meta.kind, e.meta.notes, e.meta.note, e.meta.reason].filter(Boolean).join(' · ')}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : view === 'edit' ? (
        <div className="space-y-5">
          <Select label="Address" value={addrId} onChange={(e) => { setAddrId(e.target.value); const a = customer.data?.addresses.find((x) => x.id === e.target.value); if (a) setParking(a.parking_location); }}>
            <option value="">Keep as it is</option>
            {customer.data?.addresses.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.label} · {a.society_name}, {a.building_block} {a.flat_number}</option>)}
          </Select>
          <Input label="Parking spot" value={parking} onChange={(e) => setParking(e.target.value)} maxLength={160} />
          <TextArea label="Note for the specialist" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          <div className="grid grid-cols-2 gap-3"><Button variant="glass" onClick={() => setView('details')}>Back</Button><Button loading={act.isPending} onClick={() => void run(`bookings/${b.id}`, { address_id: addrId || null, parking_location: parking, note }, 'Saved', 'PUT')}>Save details</Button></div>
        </div>
      ) : view === 'move' ? (
        <div className="space-y-5">
          <DateSlotPicker date={date} slot={slot} onDate={setDate} onSlot={setSlot} min={todayIST()} days={45} />
          <Input label="Reason" optional value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          <div className="grid grid-cols-2 gap-3"><Button variant="glass" onClick={() => setView('details')}>Back</Button><Button disabled={!date || !slot} loading={act.isPending} onClick={() => void run(`bookings/${b.id}/reschedule`, { date, time_slot: slot, reason }, 'Rescheduled')}>Move wash</Button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <TextArea label="Reason (the customer and specialist will see it)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          <p className="text-xs text-fog">Cancelling a paid on-demand wash raises a refund request. For a membership wash, consider rescheduling instead.</p>
          <div className="grid grid-cols-2 gap-3"><Button variant="glass" onClick={() => setView('details')}>Back</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={act.isPending} onClick={() => void run(`bookings/${b.id}/cancel`, { reason }, 'Cancelled')}>Cancel wash</Button></div>
        </div>
      )}
    </Sheet>
  );
}
