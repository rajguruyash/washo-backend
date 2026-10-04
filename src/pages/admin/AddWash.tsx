import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { DateSlotPicker } from '../../components/DateSlotPicker';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { formatPlate, prettyPhone, rupees, todayIST, vehicleLabel } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useAdminAction, useAdminCustomer, useAdminCustomers, useCatalog } from '../../lib/queries';
import type { SlotId } from '../../lib/types';
import { errText } from './shared';

/** WASHO books a wash for a customer: paid to WASHO in cash (recorded at the rate-card price) or complimentary. */
export function AddWashSheet({ open, customerId, onClose, onCreated }: { open: boolean; customerId?: string | null; onClose: () => void; onCreated: (bookingId: string) => void }) {
  const toast = useToast();
  const act = useAdminAction();
  const catalog = useCatalog();
  const [picked, setPicked] = useState<string | null>(customerId ?? null);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(t); }, [q]);
  const found = useAdminCustomers(debounced, 'active');
  const detail = useAdminCustomer(picked ?? undefined);

  const [vehicleId, setVehicleId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<SlotId | null>(null);
  const [addressId, setAddressId] = useState('');
  const [parking, setParking] = useState('');
  const [payment, setPayment] = useState<'cash' | 'online' | 'free'>('cash');
  const [payId, setPayId] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => { if (open) setPicked(customerId ?? null); }, [open, customerId]);
  useEffect(() => { setVehicleId(''); setServiceId(''); setAddressId(''); setParking(''); setNote(''); setPayment('cash'); setPayId(''); }, [picked, open]);
  useEffect(() => { if (open) { setDate(null); setSlot(null); } }, [open]);

  const vehicles = (detail.data?.vehicles ?? []).filter((v) => v.is_active);
  const addresses = (detail.data?.addresses ?? []).filter((a) => !a.archived);
  const vehicle = vehicles.find((v) => v.id === vehicleId);
  useEffect(() => {
    if (!vehicle) return;
    setServiceId('');
    const a = addresses.find((x) => x.id === vehicle.address_id) ?? addresses.find((x) => x.is_default) ?? addresses[0];
    setAddressId(a?.id ?? '');
    setParking(vehicle.parking_location ?? a?.parking_location ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId]);

  const services = useMemo(() => {
    if (!vehicle) return [];
    return (catalog.data?.services ?? [])
      .filter((s) => s.vehicle_type === vehicle.vehicle_type || (vehicle.vehicle_type === 'suv' && s.vehicle_type === 'car'))
      .map((s) => ({ ...s, price: s.unit_prices?.find((p) => p.vehicle_type === vehicle.vehicle_type)?.price_cents ?? null }))
      .filter((s) => s.price != null);
  }, [vehicle, catalog.data]);
  const service = services.find((s) => s.id === serviceId);
  const ready = Boolean(picked && vehicle && service && date && slot && (payment !== 'online' || /^pay_[A-Za-z0-9]{6,40}$/.test(payId.trim())));

  const submit = async () => {
    if (!picked || !vehicle || !service || !date || !slot) return;
    try {
      const r = await act.mutateAsync({ path: 'bookings', body: { customer_id: picked, vehicle_id: vehicle.id, service_id: service.id, date, time_slot: slot, address_id: addressId || null, parking_location: parking || undefined, payment, razorpay_payment_id: payment === 'online' ? payId.trim() : undefined, note: note || undefined } });
      toast.success(payment === 'cash' ? `Wash booked and recorded as paid in cash (${rupees(r.price_cents)})` : payment === 'online' ? `Wash booked and the Razorpay payment recorded (${rupees(r.price_cents)})` : 'Complimentary wash booked');
      onCreated(r.booking_id);
      onClose();
    } catch (err) { toast.error(err instanceof ApiError ? err.message : errText(err)); }
  };

  return (
    <Sheet open={open} onClose={onClose} size="lg" title="Book a wash" description="For a customer who asked WASHO to book it. It appears in their app like any other wash."
      footer={<Button full size="lg" disabled={!ready} loading={act.isPending} onClick={() => void submit()}>{payment === 'cash' && service ? `Book · paid in cash ${rupees(service.price!)}` : payment === 'online' && service ? `Book · paid online ${rupees(service.price!)}` : 'Book complimentary wash'}</Button>}>
      <div className="space-y-6">
        {!customerId && !picked && (
          <div>
            <div className="relative mb-3"><Search className="pointer-events-none absolute left-4 top-3.5 h-4 w-4 text-fog" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find the customer by name or phone" aria-label="Find a customer" className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] pl-11 pr-4 outline-none focus:border-washo-400" /></div>
            <ul className="space-y-2">
              {found.data?.slice(0, 8).map((c) => (
                <li key={c.id}><button onClick={() => setPicked(c.id)} className="panel flex w-full items-center justify-between gap-3 p-3 text-left hover:border-washo-400/40"><span><span className="font-semibold">{c.full_name ?? 'No name yet'}</span><span className="block text-xs text-fog">{prettyPhone(c.phone)}</span></span><Badge>{c.vehicles} vehicle{c.vehicles === 1 ? '' : 's'}</Badge></button></li>
              ))}
              {found.data && !found.data.length && <li className="panel p-4 text-center text-sm text-fog">No customers found. Add them from the People tab first.</li>}
            </ul>
          </div>
        )}

        {picked && detail.data && (
          <>
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 p-3 text-sm">
              <div><p className="font-semibold">{detail.data.customer.full_name}</p><p className="text-xs text-fog">{prettyPhone(detail.data.customer.phone)}</p></div>
              {!customerId && <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Change</Button>}
            </div>

            {!vehicles.length ? (
              <p className="panel p-4 text-sm text-fog">This customer has no vehicle yet. Add one from their page in the People tab, then come back.</p>
            ) : (
              <>
                <Select label="Vehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                  <option value="">Choose…</option>
                  {vehicles.map((v) => <option key={v.id} value={v.id}>{vehicleLabel[v.vehicle_type]} · {v.model} · {formatPlate(v.registration_number)}</option>)}
                </Select>

                {vehicle && (
                  <>
                    <Select label="Service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                      <option value="">Choose…</option>
                      {services.map((s) => <option key={s.id} value={s.id}>{s.name} · {rupees(s.price!)}</option>)}
                    </Select>
                    <DateSlotPicker date={date} slot={slot} onDate={setDate} onSlot={setSlot} min={todayIST()} days={30} />
                    <Select label="Address" value={addressId} onChange={(e) => { setAddressId(e.target.value); const a = addresses.find((x) => x.id === e.target.value); if (a) setParking(a.parking_location); }}>
                      <option value="">Their usual address</option>
                      {addresses.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.society_name}, {a.flat_number}</option>)}
                    </Select>
                    <Input label="Parking spot" optional value={parking} onChange={(e) => setParking(e.target.value)} maxLength={160} />
                    <div>
                      <p className="mb-1.5 text-[13px] font-medium text-mist">Payment</p>
                      <Segmented label="Payment" value={payment} onChange={setPayment} options={[{ value: 'cash', label: 'Cash' }, { value: 'online', label: 'Paid online' }, { value: 'free', label: 'Complimentary' }]} />
                      {payment === 'online' && <Input className="mt-3" label="Razorpay payment id" value={payId} onChange={(e) => setPayId(e.target.value)} placeholder="pay_…" hint="From the Razorpay dashboard (Payments). We check it with Razorpay: it must be captured, for exactly this price, and not used before." />}
                      <p className="mt-2 text-xs text-fog">{payment === 'cash' ? 'Paid to WASHO directly. Recorded as a paid wash at the rate-card price. If it is cancelled later, you refund the cash yourself and record it.' : payment === 'online' ? 'For a customer who paid through Razorpay but whose booking never got recorded. A cancellation can then be refunded through Razorpay.' : 'No charge, nothing to refund.'}</p>
                    </div>
                    <Input label="Note for the specialist" optional value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
