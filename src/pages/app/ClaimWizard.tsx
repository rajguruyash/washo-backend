import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Check, Gift, Info, Plus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AddressSheet, addressLine } from '../../components/AddressSheet';
import { Plate } from '../../components/brand/Plate';
import { WizardStepper } from '../../components/WizardStepper';
import { stepMotion, useStepDirection } from '../../lib/stepMotion';
import { ErrorState } from '../../components/EmptyState';
import { PackOfferCard } from '../../components/PackOfferCard';
import { PayPhoneGate } from '../../components/PayPhoneGate';
import { useNeedsPhone } from '../../lib/useNeedsPhone';
import { SlideToPay } from '../../components/SlideToPay';
import { addressBlocker, pausedBlocker, phoneBlocker } from '../../lib/payBlockers';
import { VehiclePicker } from '../../components/VehiclePicker';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { claimView, dayOf } from '../../lib/campaign';
import { cn } from '../../lib/cn';
import { prettyDate, rupees } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useAddresses, useCampaign, useCatalog, useClaimFreeWash, usePublicSettings, useSaveProfile, useVehicles } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import type { Campaign, Vehicle } from '../../lib/types';
import { useAuth } from '../../state/auth';

const STEPS = ['Vehicle', 'Claim'] as const;

/** A card that says why the wizard is not shown (offer closed, already claimed, not new, ...). */
function Gate({ title, children, actions }: { title: string; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-lg py-10 text-center">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.06] text-offer"><Gift className="h-7 w-7" aria-hidden /></span>
      <h1 className="mt-5 text-2xl font-extrabold">{title}</h1>
      <div className="mt-3 space-y-3 text-fog">{children}</div>
      <div className="mt-8 flex flex-wrap justify-center gap-3">{actions}</div>
    </div>
  );
}

/** Claim the free wash: the vehicle, then slide. There is no day or time to choose: WASHO places the wash and says when it is. The database checks every rule and books it in one step. */
export default function ClaimWizard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: status, isLoading, isError, refetch } = useCampaign();
  const { data: vehicles } = useVehicles();
  const { data: addresses } = useAddresses();
  const { data: catalog } = useCatalog();
  const claim = useClaimFreeWash();
  const toast = useToast();
  const saveProfile = useSaveProfile();
  // A customer who signed in by phone may have no email yet: ask for one, so the confirmation can be mailed. Optional.
  const [email, setEmail] = useState('');
  const [step, setStep] = useState(0);
  const dir = useStepDirection(step);
  const needsPhone = useNeedsPhone(); // signed in by email: a mobile number first
  const paused = usePublicSettings().data;
  const [picked, setVehicle] = useState<Vehicle | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [addrOpen, setAddrOpen] = useState(false);
  const [error, setError] = useState('');
  // While the claim goes through, the offer's own status flips to "booked"; that must not swap the slider away mid-animation.
  const [claiming, setClaiming] = useState(false);
  const booked = useRef<string | null>(null);
  const campaign = status?.campaign ?? null;

  // Someone with one vehicle does not have to pick it.
  const vehicle = picked ?? (vehicles?.length === 1 ? vehicles[0] : null);

  // Where we come to wash: the vehicle's own address, else the default one, else the first.
  const address = useMemo(
    () => addresses?.find((a) => a.id === addressId) ?? addresses?.find((a) => a.id === vehicle?.address_id) ?? addresses?.find((a) => a.is_default) ?? addresses?.[0],
    [addresses, addressId, vehicle]
  );

  // What the wash would cost: the body wash for this vehicle (an SUV uses the car body wash), shown struck through next to FREE.
  const body = vehicle ? catalog?.services.find((s) => s.code === (vehicle.vehicle_type === 'bike' ? 'bike-body-wash' : 'car-body-wash')) : undefined;
  const worth = body?.unit_prices?.find((p) => p.vehicle_type === (vehicle?.vehicle_type === 'suv' ? 'car' : vehicle?.vehicle_type))?.price_cents;

  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !status) return <div className="mx-auto max-w-3xl space-y-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;

  const view = claiming && campaign ? 'eligible' : claimView(status, user?.role);
  const me = status.me;
  if (view === 'none') {
    return <Gate title="No free-wash offer is running right now" actions={<><ButtonLink to="/app/membership/new">Build a membership</ButtonLink><ButtonLink to="/app" variant="glass">Back home</ButtonLink></>}><p>Check back soon.</p></Gate>;
  }
  if (view === 'booked' && me && 'booking_id' in me) {
    return <Gate title="You have already claimed your free wash" actions={<ButtonLink to={`/app/bookings/${me.booking_id}`}>View my free wash</ButtonLink>}><p>{me.scheduled_date ? `It is on ${prettyDate(me.scheduled_date)}${me.time_slot ? `, ${slotLabel(me.time_slot)}` : ''}.` : null} One free wash for each customer.</p></Gate>;
  }
  if (view === 'completed') {
    return <Gate title="You have had your free wash" actions={!status.offer ? <ButtonLink to="/app/membership/new">Build a membership</ButtonLink> : undefined}>{status.offer ? <PackOfferCard offer={status.offer} className="text-left" /> : <p>We hope you loved it.</p>}</Gate>;
  }
  if (view === 'forfeited') return <Gate title="Your free wash was missed" actions={<ButtonLink to="/app/membership/new">Build a membership</ButtonLink>}><p>The offer has been used. You can still start a membership any time.</p></Gate>;
  if (view === 'ineligible') return <Gate title="This offer is for new customers" actions={<><ButtonLink to="/app/membership/new">Build a membership</ButtonLink><ButtonLink to="/app/book" variant="glass">Book a wash</ButtonLink></>}><p>You have already had a wash with WASHO, so the free wash is not available on this account.</p></Gate>;
  if (view === 'staff') return <Gate title="Sign in as a customer to claim" actions={<ButtonLink to="/app" variant="glass">Back</ButtonLink>} />;
  if (view === 'upcoming') return <Gate title={`${campaign!.name} opens on ${dayOf(campaign!.claim_opens_on)}`} actions={<ButtonLink to="/navratri" variant="glass">See the offer</ButtonLink>} />;
  if (view === 'full') return <Gate title="All the free washes have been claimed" actions={<ButtonLink to="/app/membership/new">Build a membership</ButtonLink>}><p>Thank you for your interest.</p></Gate>;

  const c = campaign as Campaign;
  const ok = [Boolean(vehicle), Boolean(address)][step];

  // Slide to claim: resolves once the wash is booked (the handle shows "Claimed"); throws if the database refused, so the handle springs back.
  const submit = async () => {
    if (!vehicle || !address) throw new Error('incomplete');
    setError('');
    const mail = email.trim();
    if (!user?.email && mail) {
      if (!/^\S+@\S+\.\S+$/.test(mail)) { setError('That email address does not look right. Fix it, or leave it empty.'); throw new Error('email'); }
      try { await saveProfile.mutateAsync({ full_name: user?.full_name ?? '', email: mail }); } catch (err) { setError(err instanceof ApiError ? err.message : 'We could not save that email. Try again, or leave it empty.'); throw err; }
    }
    setClaiming(true);
    try {
      const r = await claim.mutateAsync({ campaign_id: c.id, vehicle_id: vehicle.id, address_id: address.id, parking_location: address.parking_location });
      booked.current = r.booking_id;
      if (r.scheduled_date) toast.success(`Your free wash is booked: ${prettyDate(r.scheduled_date)}${r.time_slot ? `, ${slotLabel(r.time_slot)}` : ''}`);
    } catch (err) {
      setClaiming(false);
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      throw err;
    }
  };
  const afterClaim = () => setTimeout(() => navigate(`/app/bookings/${booked.current}`, { replace: true }), 900);
  const slide = stepMotion(dir);

  return (
    <div className="mx-auto max-w-3xl pb-28">
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link to="/app" className="inline-flex items-center gap-1.5 text-sm text-fog hover:text-white"><ArrowLeft className="h-4 w-4" /> Cancel</Link>
      </div>
      <WizardStepper steps={STEPS} step={step} onStep={(i) => { setError(''); setStep(i); }} theme="offer" />

      <AnimatePresence mode="wait" initial={false} custom={dir}>
        {step === 0 && (
          <motion.section key="s0" {...slide}>
            <p className="eyebrow text-offer">{c.name}</p>
            <h1 className="mt-1 text-3xl font-extrabold">Which vehicle gets the free wash?</h1>
            <p className="mb-6 mt-1.5 text-fog">A free body wash for one vehicle. Bike, car or SUV.</p>
            <VehiclePicker value={vehicle?.id ?? null} onChange={setVehicle} />
          </motion.section>
        )}

        {step === 1 && vehicle && (
          <motion.section key="s1" {...slide}>
            <h1 className="text-3xl font-extrabold">Claim your free wash</h1>
            <p className="mb-6 mt-1.5 text-fog">Check the details, then slide. Nothing is charged.</p>
            <div className="glass divide-y divide-white/[0.07] text-sm">
              <div className="flex items-center justify-between gap-4 p-5"><div><p className="eyebrow">Vehicle</p><p className="mt-1 font-bold">{vehicle.make ? `${vehicle.make} ` : ''}{vehicle.model}</p></div><Plate reg={vehicle.registration_number} /></div>
              <div className="flex justify-between gap-4 p-5"><span className="text-fog">Wash</span><span className="font-semibold">{body?.name ?? 'Body wash'}</span></div>
              <div className="flex justify-between gap-4 p-5"><span className="text-fog">When</span><span className="max-w-[60%] text-right font-semibold">We pick the day and time, and show it as soon as you claim</span></div>
              <div className="flex items-center justify-between gap-4 p-5">
                <span className="text-fog">Price</span>
                <span className="flex items-baseline gap-2">{worth ? <s className="text-fog">{rupees(worth)}</s> : null}<span className="font-display text-2xl font-extrabold text-offer">FREE</span></span>
              </div>
              <div id="pay-address" className="p-5">
                <p className="eyebrow">Where</p>
                {addresses?.length ? (
                  <div className="mt-2 space-y-2">
                    {addresses.map((a) => (
                      <button key={a.id} type="button" onClick={() => setAddressId(a.id)} aria-pressed={a.id === address?.id} className={cn('flex w-full items-start gap-3 rounded-2xl border p-3 text-left text-sm transition-colors', a.id === address?.id ? 'border-washo-400/60 bg-washo-500/10' : 'border-white/10 hover:border-white/20')}>
                        <span className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border', a.id === address?.id ? 'border-washo-400 bg-washo-500' : 'border-white/30')}>{a.id === address?.id && <Check className="h-3 w-3" strokeWidth={3} />}</span>
                        <span><span className="block font-semibold">{a.label} · {addressLine(a)}</span><span className="text-xs text-fog">Parking: {a.parking_location}</span></span>
                      </button>
                    ))}
                  </div>
                ) : <p className="mt-2 text-sm text-warn">Add an address so our specialist knows where to come.</p>}
                <Button variant="glass" size="sm" className="mt-3" icon={<Plus className="h-4 w-4" />} onClick={() => setAddrOpen(true)}>Add an address</Button>
              </div>
            </div>
            {!user?.email && <div className="mt-5"><Input label="Email" type="email" optional value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" hint="We will email your booking confirmation. You can leave this empty." /></div>}
            <div className="mt-5 flex items-start gap-3 rounded-2xl border border-offer/25 bg-offer/10 p-4 text-sm text-mist">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-offer" />
              <p>One free wash for each phone number, vehicle and flat. If you cancel it, the claim comes back while the offer is open (until {dayOf(c.claim_closes_on)}). A specialist calls ahead on the day.</p>
            </div>
            <PayPhoneGate what="claim" />
            {error && <p role="alert" className="mt-4 text-sm text-bad">{error}</p>}
          </motion.section>
        )}
      </AnimatePresence>

      <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-ink-900/90 backdrop-blur-xl lg:left-[17rem]">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
          <Button variant="glass" size="lg" disabled={step === 0} onClick={() => { setError(''); setStep(step - 1); }} aria-label="Back" icon={<ArrowLeft className="h-5 w-5" />} />
          {step < STEPS.length - 1 ? (
            <Button size="lg" full disabled={!ok} onClick={() => setStep(step + 1)} iconRight={<ArrowRight className="h-5 w-5" />}>Continue</Button>
          ) : (
            <SlideToPay label="Slide to claim your free wash" doneLabel="Claimed" errorLabel="Could not claim" disabled={claim.isPending} blockers={[...pausedBlocker(paused), ...addressBlocker(Boolean(address)), ...phoneBlocker(needsPhone, 'claim')]} onConfirm={submit} onDone={afterClaim} />
          )}
        </div>
      </div>
      <AddressSheet open={addrOpen} onClose={() => setAddrOpen(false)} onSaved={(a) => setAddressId(a.id)} />
    </div>
  );
}
