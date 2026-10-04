import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CountPrice } from '../../components/CountPrice';
import { DateSlotPicker } from '../../components/DateSlotPicker';
import { ErrorState } from '../../components/EmptyState';
import { ServicePhoto } from '../../components/ServicePhoto';
import { SlideToPay } from '../../components/SlideToPay';
import { VehiclePicker } from '../../components/VehiclePicker';
import { Skeleton } from '../../components/ui/Skeleton';
import { Button } from '../../components/ui/Button';
import { cn } from '../../lib/cn';
import { addDays, prettyDate, rupees, todayIST } from '../../lib/format';
import { useAddresses, useCatalog, useStartOnDemandPayment, useVehicles } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import type { SlotId, Vehicle } from '../../lib/types';
import { usePay } from '../../lib/usePay';

/** One-off wash. Priced by the database from the rate card; the membership is the main WASHO product. */
export default function BookWizard() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: catalog, isLoading: catalogLoading, isError: catalogError, error: catalogErr, refetch: refetchCatalog } = useCatalog();
  const { data: vehicles } = useVehicles();
  const { data: addresses } = useAddresses();
  const start = useStartOnDemandPayment();
  const { pay, paying } = usePay();
  const [step, setStep] = useState(0);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<SlotId | null>(null);

  useEffect(() => {
    if (vehicle || !vehicles?.length) return;
    setVehicle(vehicles.find((v) => v.id === params.get('vehicle')) ?? (vehicles.length === 1 ? vehicles[0] : null));
  }, [vehicles, params, vehicle]);

  // Services for this vehicle with the rate-card price the database will charge.
  const options = useMemo(() => {
    if (!vehicle || !catalog) return [];
    return catalog.services
      .filter((s) => s.vehicle_type === vehicle.vehicle_type || (vehicle.vehicle_type === 'suv' && s.vehicle_type === 'car'))
      .map((s) => ({ ...s, price: s.unit_prices?.find((p) => p.vehicle_type === vehicle.vehicle_type)?.price_cents ?? null }))
      .filter((s) => s.price != null);
  }, [vehicle, catalog]);
  const service = options.find((s) => s.id === serviceId);
  const address = addresses?.find((a) => a.id === vehicle?.address_id) ?? addresses?.find((a) => a.is_default) ?? addresses?.[0];
  const ok = [Boolean(vehicle), Boolean(service), Boolean(date && slot), true][step];

  // Slide to pay: resolves only when the payment is verified; throws if it was not, so the handle springs back.
  const paidBooking = useRef<string | null>(null);
  const submit = async () => {
    if (!vehicle || !service || !date || !slot) throw new Error('incomplete');
    const result = await pay(
      () => start.mutateAsync({ vehicle_id: vehicle.id, service_id: service.id, scheduled_date: date, time_slot: slot, address_id: address?.id, parking_location: address?.parking_location }),
      `${service.name} · ${prettyDate(date)}`
    );
    if (!result?.booking_id) throw new Error('not paid');
    paidBooking.current = result.booking_id;
  };
  const afterPaid = () => {
    setTimeout(() => navigate(`/app/bookings/${paidBooking.current}`, { replace: true }), 1000);
  };

  return (
    <div className="mx-auto max-w-3xl pb-28">
      <div className="mb-6 flex items-center justify-between"><Link to="/app/bookings" className="inline-flex items-center gap-1.5 text-sm text-fog hover:text-white"><ArrowLeft className="h-4 w-4" /> Cancel</Link><p className="text-sm font-semibold text-mist">Step {step + 1} of 4</p></div>

      {step === 0 && <section><h1 className="text-3xl font-extrabold">Which vehicle?</h1><p className="mb-6 mt-1.5 text-fog">A single wash. For regular washing a membership is better value.</p><VehiclePicker value={vehicle?.id ?? null} onChange={(v) => { setVehicle(v); setServiceId(null); }} /></section>}

      {step === 1 && (
        <section>
          <h1 className="text-3xl font-extrabold">Choose a service</h1>
          {catalogError && <div className="mt-6"><ErrorState message={(catalogErr as Error)?.message ?? 'We could not load the services and prices.'} onRetry={() => void refetchCatalog()} /></div>}
          {catalogLoading && <div className="mt-6 space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-24 rounded-3xl" />)}</div>}
          {!catalogLoading && !catalogError && !options.length && <p className="mt-6 text-sm text-fog">No services are available for this vehicle right now.</p>}
          <div className="mt-6 grid gap-3" role="radiogroup" aria-label="Service">
            {options.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={s.id === serviceId} onClick={() => setServiceId(s.id)} className={cn('flex items-center gap-4 rounded-3xl border p-4 text-left transition-all', s.id === serviceId ? 'border-washo-400/70 bg-washo-500/15' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20')}>
                <ServicePhoto code={s.code} name={s.name} className="h-20 w-20 shrink-0 rounded-2xl" />
                <span className="min-w-0 flex-1"><span className="block font-bold">{s.name}</span><span className="mt-1 block text-sm text-fog">{s.tagline ?? s.description}</span></span>
                <CountPrice className="font-display text-2xl font-extrabold" cents={s.price!} code={s.code} />
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 2 && <section><h1 className="mb-6 text-3xl font-extrabold">Pick a date and time</h1><DateSlotPicker date={date} slot={slot} onDate={setDate} onSlot={setSlot} min={todayIST()} max={addDays(todayIST(), 21)} days={22} /></section>}

      {step === 3 && vehicle && service && date && slot && (
        <section>
          <h1 className="mb-6 text-3xl font-extrabold">Review and pay</h1>
          <div className="glass divide-y divide-white/[0.07] text-sm">
            <div className="flex justify-between p-5"><span className="text-fog">Service</span><span className="font-semibold">{service.name}</span></div>
            <div className="flex justify-between p-5"><span className="text-fog">Vehicle</span><span className="font-semibold">{vehicle.model} · {vehicle.registration_number}</span></div>
            <div className="flex justify-between p-5"><span className="text-fog">When</span><span className="font-semibold">{prettyDate(date)}, {slotLabel(slot)}</span></div>
            <div className="flex justify-between p-5"><span className="text-fog">Total</span><span className="font-display text-xl font-extrabold">{rupees(service.price!)}</span></div>
          </div>
          <p className="mt-4 text-xs text-fog">Your wash is booked once the payment is verified. The price is set by WASHO's rate card, not by this page.</p>
        </section>
      )}

      <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t lg:left-[17rem] border-white/[0.08] bg-ink-900/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
          <Button variant="glass" size="lg" disabled={step === 0} onClick={() => setStep(step - 1)} aria-label="Back" icon={<ArrowLeft className="h-5 w-5" />} />
          {step < 3 ? <Button size="lg" full disabled={!ok} onClick={() => setStep(step + 1)} iconRight={<ArrowRight className="h-5 w-5" />}>Continue</Button> : <SlideToPay label={`Slide to pay ${service ? rupees(service.price!) : ''}`.trim()} disabled={!service || paying || start.isPending} onConfirm={submit} onDone={afterPaid} />}
        </div>
      </div>
    </div>
  );
}
