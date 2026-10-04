import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Check, CreditCard, Info, Plus, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AddressSheet, addressLine } from '../../components/AddressSheet';
import { Plate } from '../../components/brand/Plate';
import { DateSlotPicker } from '../../components/DateSlotPicker';
import { QuoteBreakdownView } from '../../components/Quote';
import { VehiclePicker } from '../../components/VehiclePicker';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { TextArea } from '../../components/ui/Field';
import { cn } from '../../lib/cn';
import { addDays, percent, prettyDate, rupees, todayIST, WEEKDAYS } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { defaultPattern, useAddresses, useCatalog, useEstimate, useStartMembershipPayment, useVehicles } from '../../lib/queries';
import { usePay } from '../../lib/usePay';
import { slotLabel } from '../../lib/slots';
import type { SlotId, Vehicle, VehicleType, WashKind } from '../../lib/types';

const STEPS = ['Vehicle', 'Washes a week', 'Days & washes', 'Length', 'Start & time', 'Review & pay'] as const;
const MONTHS = [1, 3, 6, 12] as const;
const PER_WEEK = [1, 2, 3, 4, 5, 6, 7] as const;

const perWeekHint = (n: number, bike: boolean) =>
  bike ? `${n} bike wash${n > 1 ? 'es' : ''} a week` : n === 1 ? 'One wash type: Body or Deep' : n === 2 ? '1 Body wash + 1 Deep cleaning' : `A mix of Body washes and Deep cleanings, ${n} a week`;
const KIND_LABEL: Record<WashKind, string> = { body: 'Body wash', deep: 'Deep cleaning' };

/** The membership composition rules, for guidance only. The database re-checks every one of them. */
function compositionError(perWeek: number, kinds: WashKind[], bike: boolean): string | null {
  if (bike) return null;
  const body = kinds.filter((k) => k === 'body').length;
  const deep = kinds.length - body;
  if (perWeek === 2 && !(body === 1 && deep === 1)) return '2 washes a week is 1 body wash + 1 deep cleaning.';
  if (perWeek >= 3 && (body < 1 || deep < 1)) return `${perWeek} washes a week mixes body washes and deep cleanings.`;
  return null;
}

/** The total for one length option, e.g. "₹1,800 total · ₹600 / month". */
function DurationPrice({ vehicleType, pattern, months }: { vehicleType: VehicleType; pattern: { weekday: number; kind: WashKind }[]; months: number }) {
  const { data } = useEstimate({ vehicle_type: vehicleType, weekly_pattern: pattern, duration_months: months });
  if (!data) return <p className="mt-2 h-5 text-sm text-fog">…</p>;
  return <p className="mt-2 text-sm font-semibold tabular-nums">{rupees(data.final_cents)} <span className="font-normal text-fog">total · {rupees(Math.round(data.final_cents / months))} / month</span></p>;
}

export default function MembershipWizard() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: catalog } = useCatalog();
  const { data: vehicles } = useVehicles();
  const { data: addresses } = useAddresses();
  const checkout = useStartMembershipPayment();
  const { pay, paying } = usePay();

  const [step, setStep] = useState(0);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [perWeek, setPerWeek] = useState<number | null>(() => {
    const n = Number(params.get('perWeek'));
    return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
  });
  const [days, setDays] = useState<number[]>([]);
  const [kindByDay, setKindByDay] = useState<Record<number, WashKind>>({});
  const [months, setMonths] = useState<number | null>(null);
  const [slot, setSlot] = useState<SlotId | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [addrOpen, setAddrOpen] = useState(false);
  const [error, setError] = useState('');

  // Preselect from ?vehicle= (Vehicles page) or the only vehicle.
  useEffect(() => {
    if (vehicle || !vehicles?.length) return;
    const wanted = params.get('vehicle');
    const wantedType = params.get('type');
    const v = vehicles.find((x) => x.id === wanted) ?? (wantedType ? vehicles.find((x) => x.vehicle_type === wantedType) : undefined) ?? (vehicles.length === 1 ? vehicles[0] : null);
    if (v) setVehicle(v);
  }, [vehicles, params, vehicle]);

  useEffect(() => {
    if (!addressId && addresses?.length) setAddressId((vehicle?.address_id && addresses.find((a) => a.id === vehicle.address_id)?.id) || addresses.find((a) => a.is_default)?.id || addresses[0].id);
  }, [addresses, vehicle, addressId]);

  const bike = vehicle?.vehicle_type === 'bike';
  const sortedDays = useMemo(() => [...days].sort((a, b) => a - b), [days]);
  const kinds = sortedDays.map((d) => kindByDay[d] ?? 'body');
  const comp = perWeek ? compositionError(perWeek, kinds, Boolean(bike)) : null;
  const minStart = addDays(todayIST(), 2);
  const address = addresses?.find((a) => a.id === addressId);
  const weeks = catalog?.weeks_per_month ?? 4;
  const total = perWeek && months ? perWeek * weeks * months : 0;

  const vtype = vehicle?.vehicle_type;
  const pattern = sortedDays.map((d) => ({ weekday: d, kind: (bike ? 'body' : kindByDay[d] ?? 'body') as WashKind }));
  const planReady = Boolean(vtype && perWeek && days.length === perWeek && !comp);
  // Before the days are chosen, price the default mix so the number toggle already shows what each choice costs per month.
  const previewPattern = vtype && perWeek ? defaultPattern(vtype, perWeek) : null;
  const monthly = useEstimate(vtype && planReady ? { vehicle_type: vtype, weekly_pattern: pattern, duration_months: 1 } : vtype && previewPattern ? { vehicle_type: vtype, weekly_pattern: previewPattern, duration_months: 1 } : null);
  const chosenEstimate = useEstimate(vtype && planReady && months ? { vehicle_type: vtype, weekly_pattern: pattern, duration_months: months } : null);

  const serviceName = (kind: WashKind) => {
    const code = catalog?.membership_options.find((o) => o.vehicle_type === vehicle?.vehicle_type && o.wash_kind === kind)?.service_code;
    return catalog?.services.find((s) => s.code === code)?.name ?? KIND_LABEL[kind];
  };
  const basePrice = (kind: WashKind): number => {
    const code = catalog?.membership_options.find((o) => o.vehicle_type === vehicle?.vehicle_type && o.wash_kind === kind)?.service_code;
    return catalog?.services.find((x) => x.code === code)?.unit_prices?.find((p) => p.vehicle_type === vehicle?.vehicle_type)?.price_cents ?? 0;
  };
  const discount = (kind: 'frequency' | 'duration', key: number) => catalog?.discounts.find((d) => d.kind === kind && d.key === key)?.discount_bp ?? 0;

  const choosePerWeek = (n: number) => {
    setPerWeek(n);
    setDays([]);
    setKindByDay({});
  };

  const toggleDay = (d: number) => {
    if (!perWeek) return;
    if (days.includes(d)) {
      setDays(days.filter((x) => x !== d));
      return;
    }
    if (days.length >= perWeek) return;
    const have = days.map((x) => kindByDay[x] ?? 'body');
    let kind: WashKind = 'body';
    if (!bike) {
      if (perWeek === 2) kind = have.includes('body') ? 'deep' : 'body';
      else if (perWeek >= 3) kind = have.length % 2 === 1 ? 'deep' : 'body'; // Body, Deep, Body, Deep ...
    }
    setDays([...days, d]);
    setKindByDay({ ...kindByDay, [d]: kind });
  };

  const setKind = (d: number, k: WashKind) => {
    const next = { ...kindByDay, [d]: k };
    if (perWeek === 2 && sortedDays.length === 2) {
      const other = sortedDays.find((x) => x !== d)!;
      next[other] = k === 'body' ? 'deep' : 'body';
    }
    setKindByDay(next);
  };

  const canNext = [
    Boolean(vehicle),
    Boolean(perWeek),
    Boolean(perWeek && days.length === perWeek && !comp),
    Boolean(months),
    Boolean(slot && start),
    Boolean(addressId),
  ][step];

  // Pay now: the server prices the plan from the rate card and opens the Razorpay order; the membership and its washes are
  // created only once the payment is verified.
  const submit = async () => {
    if (!vehicle || !perWeek || !months || !slot || !start) return;
    setError('');
    try {
      const result = await pay(
        () => checkout.mutateAsync({
          vehicle_id: vehicle.id,
          weekly_pattern: sortedDays.map((d) => ({ weekday: d, kind: bike ? 'body' : kindByDay[d] ?? 'body' })),
          duration_months: months,
          time_slot: slot,
          start_date: start,
          address_id: addressId,
          parking_location: address?.parking_location,
          customer_notes: notes.trim() || undefined,
        }),
        `WASHO membership · ${perWeek} a week · ${months} month${months > 1 ? 's' : ''}`
      );
      if (result?.membership_id) navigate(`/app/membership/${result.membership_id}?new=1`, { replace: true });
    } catch (err) {
      // usePay reports payment problems itself; this covers plan problems the database refused (shown under the button)
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  const slide = { initial: { opacity: 0, x: 24 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -24 }, transition: { duration: 0.2 } };

  return (
    <div className="mx-auto max-w-3xl pb-28">
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link to="/app/membership" className="inline-flex items-center gap-1.5 text-sm text-fog hover:text-white"><ArrowLeft className="h-4 w-4" /> Cancel</Link>
        <p className="text-sm font-semibold text-mist">Step {step + 1} of {STEPS.length} · {STEPS[step]}</p>
      </div>
      <div className="mb-8 flex gap-1.5" aria-hidden>
        {STEPS.map((s, i) => <span key={s} className={cn('h-1.5 flex-1 rounded-full transition-colors duration-500', i <= step ? 'bg-washo-400' : 'bg-white/10')} />)}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {step === 0 && (
          <motion.section key="s0" {...slide}>
            <h1 className="text-3xl font-extrabold">Which vehicle?</h1>
            <p className="mt-1.5 mb-6 text-fog">Your membership is for one vehicle. You can start another one later.</p>
            <VehiclePicker value={vehicle?.id ?? null} onChange={(v) => { setVehicle(v); setDays([]); setKindByDay({}); }} />
          </motion.section>
        )}

        {step === 1 && (
          <motion.section key="s1" {...slide}>
            <h1 className="text-3xl font-extrabold">How many washes a week?</h1>
            <p className="mt-1.5 mb-6 text-fog">Slide the toggle to the number you want. You choose the days next.</p>

            <div role="radiogroup" aria-label="Washes a week" className="grid grid-cols-7 gap-1.5 rounded-3xl border border-white/[0.09] bg-white/[0.03] p-1.5">
              {PER_WEEK.map((n) => {
                const active = perWeek === n;
                return (
                  <button key={n} type="button" role="radio" aria-checked={active} onClick={() => choosePerWeek(n)} className={cn('relative grid h-16 place-items-center rounded-2xl font-display text-2xl font-extrabold transition-colors sm:h-20 sm:text-3xl', active ? 'text-white' : 'text-fog hover:text-white')}>
                    {active && <motion.span layoutId="perweek-pill" className="absolute inset-0 rounded-2xl border border-washo-400/60 bg-washo-500/30 shadow-[0_0_30px_-8px_rgb(63_124_255/0.8)]" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
                    <span className="relative">{n}</span>
                  </button>
                );
              })}
            </div>

            {perWeek ? (
              <div className="glass mt-5 p-5" aria-live="polite">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-lg font-bold">{perWeek} wash{perWeek > 1 ? 'es' : ''} a week · {perWeek * weeks} a month</p>
                    <p className="mt-1 text-sm text-fog">{perWeekHint(perWeek, Boolean(bike))}</p>
                    {discount('frequency', perWeek) > 0 && <Badge tone="yellow" className="mt-3" icon={<Sparkles className="h-3 w-3" />}>{percent(discount('frequency', perWeek))} off for {perWeek} a week</Badge>}
                  </div>
                  <div className="text-right">
                    <p className="eyebrow">Price</p>
                    <p className="font-display text-3xl font-extrabold tabular-nums">{monthly.data ? rupees(monthly.data.final_cents) : '…'}<span className="ml-1 text-sm font-medium text-fog">/ month</span></p>
                    <p className="text-xs text-fog">{planReady ? 'for your mix' : 'with a typical mix; changes with your choice'}</p>
                  </div>
                </div>
                <p className="mt-4 border-t border-white/[0.07] pt-3 text-xs text-fog">
                  Base price per wash: {bike ? `Bike wash ${rupees(basePrice('body'))}` : `Body ${rupees(basePrice('body'))} · Deep cleaning ${rupees(basePrice('deep'))}`}.
                </p>
              </div>
            ) : (
              <p className="mt-5 text-sm text-fog">Pick a number from 1 to 7.</p>
            )}
          </motion.section>
        )}

        {step === 2 && perWeek && (
          <motion.section key="s2" {...slide}>
            <h1 className="text-3xl font-extrabold">Pick your days</h1>
            <p className="mt-1.5 mb-6 text-fog">Choose {perWeek} day{perWeek > 1 ? 's' : ''} each week{bike ? '' : perWeek > 1 ? ', then decide which wash happens on which day' : ''}.</p>
            <div className="grid grid-cols-7 gap-2" role="group" aria-label="Weekdays">
              {WEEKDAYS.map((d) => {
                const on = days.includes(d.id);
                const full = !on && days.length >= perWeek;
                return (
                  <button key={d.id} type="button" aria-pressed={on} disabled={full} onClick={() => toggleDay(d.id)} className={cn('flex h-16 flex-col items-center justify-center rounded-2xl border text-sm font-bold transition-all disabled:opacity-35', on ? 'border-washo-400/70 bg-washo-500/20' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20')}>
                    {d.short}
                    {on && <Check className="mt-0.5 h-3.5 w-3.5 text-washo-300" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>

            <div className="mt-6 space-y-3">
              {sortedDays.map((d) => {
                const kind = bike ? 'body' : kindByDay[d] ?? 'body';
                return (
                  <div key={d} className="panel flex flex-wrap items-center justify-between gap-3 p-4">
                    <div>
                      <p className="font-bold">{WEEKDAYS[d].long}</p>
                      <p className="text-xs text-fog">{serviceName(kind)}</p>
                    </div>
                    {bike ? (
                      <Badge tone="blue">Bike wash</Badge>
                    ) : (
                      <div className="flex gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1" role="radiogroup" aria-label={`Wash on ${WEEKDAYS[d].long}`}>
                        {(['body', 'deep'] as const).map((k) => (
                          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(d, k)} className={cn('rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors', kind === k ? 'bg-washo-500/30 text-white' : 'text-fog hover:text-mist')}>{KIND_LABEL[k]}</button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {days.length === perWeek && comp && <p role="alert" className="mt-4 flex items-start gap-2 text-sm text-warn"><Info className="mt-0.5 h-4 w-4 shrink-0" /> {comp}</p>}
            {days.length < perWeek && <p className="mt-4 text-sm text-fog">{perWeek - days.length} more day{perWeek - days.length > 1 ? 's' : ''} to choose.</p>}
            {planReady && monthly.data && <p className="mt-4 text-sm text-mist">Price for this mix: <span className="font-bold text-white">{rupees(monthly.data.final_cents)}</span> a month.</p>}
          </motion.section>
        )}

        {step === 3 && (
          <motion.section key="s3" {...slide}>
            <h1 className="text-3xl font-extrabold">How long?</h1>
            <p className="mt-1.5 mb-6 text-fog">Longer memberships get a bigger discount. Every discount is shown on your quote.</p>
            <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Membership length">
              {MONTHS.map((m) => {
                const off = discount('duration', m);
                const active = months === m;
                return (
                  <button key={m} type="button" role="radio" aria-checked={active} onClick={() => setMonths(m)} className={cn('rounded-3xl border p-5 text-left transition-all', active ? 'border-washo-400/70 bg-washo-500/15 shadow-[0_0_30px_-8px_rgb(63_124_255/0.7)]' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20')}>
                    <span className="font-display text-4xl font-extrabold">{m}</span>
                    <span className="ml-1.5 text-sm text-fog">month{m > 1 ? 's' : ''}</span>
                    <p className="mt-2 text-sm text-mist">{perWeek ? perWeek * weeks * m : ''} washes</p>
                    {vtype && planReady && <DurationPrice vehicleType={vtype} pattern={pattern} months={m} />}
                    {off > 0 ? <Badge tone="yellow" className="mt-3" icon={<Sparkles className="h-3 w-3" />}>{percent(off)} off</Badge> : <p className="mt-3 text-xs text-fog">Full rate</p>}
                  </button>
                );
              })}
            </div>
            {catalog && <p className="mt-4 flex items-start gap-2 text-xs text-fog"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Frequency and length discounts add up, but never beyond {percent(catalog.max_total_discount_bp)} in total.</p>}
          </motion.section>
        )}

        {step === 4 && (
          <motion.section key="s4" {...slide}>
            <h1 className="text-3xl font-extrabold">When should we start?</h1>
            <p className="mt-1.5 mb-6 text-fog">Your washes run on your chosen days at this time. The first wash is the first of those days on or after your start date.</p>
            <DateSlotPicker date={start} slot={slot} onDate={setStart} onSlot={setSlot} min={minStart} label="start date" />
          </motion.section>
        )}

        {step === 5 && vehicle && perWeek && months && slot && start && (
          <motion.section key="s5" {...slide}>
            <h1 className="text-3xl font-extrabold">Review and pay</h1>
            <p className="mt-1.5 mb-6 text-fog">Check your plan, then pay securely. Your washes are scheduled as soon as the payment is verified.</p>
            <div className="glass divide-y divide-white/[0.07]">
              <div className="flex items-center justify-between gap-4 p-5"><div><p className="eyebrow">Vehicle</p><p className="mt-1 font-bold">{vehicle.make ? `${vehicle.make} ` : ''}{vehicle.model}</p></div><Plate reg={vehicle.registration_number} /></div>
              <div className="p-5">
                <p className="eyebrow">Weekly schedule · {perWeek} a week</p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {sortedDays.map((d) => (<li key={d} className="flex justify-between gap-3"><span>{WEEKDAYS[d].long}</span><span className="text-mist">{serviceName(bike ? 'body' : kindByDay[d] ?? 'body')}</span></li>))}
                </ul>
              </div>
              <div className="grid grid-cols-2 gap-4 p-5 text-sm">
                <div><p className="eyebrow">Length</p><p className="mt-1 font-semibold">{months} month{months > 1 ? 's' : ''} · {total} washes</p></div>
                <div><p className="eyebrow">Time</p><p className="mt-1 font-semibold">{slotLabel(slot)}</p></div>
                <div><p className="eyebrow">Starting</p><p className="mt-1 font-semibold">{prettyDate(start)}</p></div>
                <div>
                  <p className="eyebrow">Discounts</p>
                  <p className="mt-1 font-semibold">{[discount('frequency', perWeek) ? `${percent(discount('frequency', perWeek))} frequency` : '', discount('duration', months) ? `${percent(discount('duration', months))} length` : ''].filter(Boolean).join(' + ') || 'None for this plan'}</p>
                </div>
              </div>
              <div className="p-5">
                <p className="eyebrow">Where</p>
                {addresses?.length ? (
                  <div className="mt-2 space-y-2">
                    {addresses.map((a) => (
                      <button key={a.id} type="button" onClick={() => setAddressId(a.id)} aria-pressed={a.id === addressId} className={cn('flex w-full items-start gap-3 rounded-2xl border p-3 text-left text-sm transition-colors', a.id === addressId ? 'border-washo-400/60 bg-washo-500/10' : 'border-white/10 hover:border-white/20')}>
                        <span className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border', a.id === addressId ? 'border-washo-400 bg-washo-500' : 'border-white/30')}>{a.id === addressId && <Check className="h-3 w-3" strokeWidth={3} />}</span>
                        <span><span className="block font-semibold">{a.label} · {addressLine(a)}</span><span className="text-xs text-fog">Parking: {a.parking_location}</span></span>
                      </button>
                    ))}
                  </div>
                ) : <p className="mt-2 text-sm text-warn">Add an address so our specialist knows where to come.</p>}
                <Button variant="glass" size="sm" className="mt-3" icon={<Plus className="h-4 w-4" />} onClick={() => setAddrOpen(true)}>Add an address</Button>
              </div>
              <div className="p-5"><TextArea label="Anything the crew should know?" optional value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} placeholder="Gate code, call before arriving, water point…" /></div>
            </div>
            {chosenEstimate.data && (
              <div className="glass mt-5 p-5">
                <div className="mb-1 flex items-center justify-between gap-3"><h2 className="font-bold">Your price</h2></div>
                <QuoteBreakdownView q={{ ...chosenEstimate.data, adjustment: { cents: 0, reason: null } }} />
              </div>
            )}
            <div className="mt-5 flex items-start gap-3 rounded-2xl border border-washo-500/25 bg-washo-500/10 p-4 text-sm text-mist"><Info className="mt-0.5 h-4 w-4 shrink-0 text-washo-300" /> You pay once, now, with Razorpay. Your membership and every wash are created when the payment is verified.</div>
            {error && <p role="alert" className="mt-4 text-sm text-bad">{error}</p>}
          </motion.section>
        )}
      </AnimatePresence>

      <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t lg:left-[17rem] border-white/[0.08] bg-ink-900/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
          <Button variant="glass" size="lg" disabled={step === 0} onClick={() => { setError(''); setStep(step - 1); }} aria-label="Back" icon={<ArrowLeft className="h-5 w-5" />} />
          {step < STEPS.length - 1 ? (
            <Button size="lg" full disabled={!canNext} onClick={() => setStep(step + 1)} iconRight={<ArrowRight className="h-5 w-5" />}>Continue</Button>
          ) : (
            <Button size="lg" full disabled={!canNext || !chosenEstimate.data} loading={checkout.isPending || paying} onClick={() => void submit()} icon={<CreditCard className="h-5 w-5" />}>Pay {chosenEstimate.data ? rupees(chosenEstimate.data.final_cents) : ''}</Button>
          )}
        </div>
      </div>
      <AddressSheet open={addrOpen} onClose={() => setAddrOpen(false)} onSaved={(a) => setAddressId(a.id)} />
    </div>
  );
}
