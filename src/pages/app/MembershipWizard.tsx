import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, ChevronDown, Info, Minus, Plus, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AddressSheet, addressLine } from '../../components/AddressSheet';
import { Plate } from '../../components/brand/Plate';
import { WizardStepper } from '../../components/WizardStepper';
import { stepMotion, useStepDirection } from '../../lib/stepMotion';
import { DateSlotPicker } from '../../components/DateSlotPicker';
import { ExactDatesCalendar } from '../../components/ExactDatesCalendar';
import { QuoteBreakdownView } from '../../components/Quote';
import { VehiclePicker } from '../../components/VehiclePicker';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Sheet } from '../../components/ui/Sheet';
import { Skeleton } from '../../components/ui/Skeleton';
import { TextArea } from '../../components/ui/Field';
import { cn } from '../../lib/cn';
import { addDays, duration, istDay, percent, prettyDate, rupees, todayIST, WEEKDAYS } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useAddresses, useCampaign, useCapacity, useCatalog, useEstimate, useMembership, usePlanPreview, useStartMembershipPayment, useVehicles } from '../../lib/queries';
import { offerBpFor, shortDayIST } from '../../lib/campaign';
import { usePay } from '../../lib/usePay';
import { SlideToPay } from '../../components/SlideToPay';
import { slotLabel } from '../../lib/slots';
import { exactDatesProblem } from '../../lib/schedule';
import type { ExactDate, Membership, SlotId, Vehicle, VehicleType, WashKind } from '../../lib/types';

const STEPS = ['Vehicle', 'Washes per week', 'Your days', 'Length', 'Start & time', 'Review & pay'] as const;
const MONTHS = [1, 3, 6, 12] as const;
const MAX_PER_WEEK = 7;
const KIND_LABEL: Record<WashKind, string> = { body: 'Body wash', deep: 'Deep clean' };

/** How many Body washes and Deep cleans a plan starts with for N washes a week: all Body for a bike, otherwise Body, Deep, Body, Deep... */
const startingMix = (n: number, bike: boolean) => ({ body: bike ? n : Math.ceil(n / 2), deep: bike ? 0 : Math.floor(n / 2) });

/** A plain pattern for pricing before the days are chosen: Body washes first, then Deep cleans, on the first weekdays. */
const previewFor = (body: number, deep: number): { weekday: number; kind: WashKind }[] =>
  [...Array.from({ length: body }, () => 'body' as WashKind), ...Array.from({ length: deep }, () => 'deep' as WashKind)].map((kind, weekday) => ({ weekday, kind }));

/** "+ / -" for one kind of wash. The (i) says what the wash includes. */
function CountRow({ label, price, value, onChange, canAdd, canRemove, onInfo, note }: { label: string; price: number; value: number; onChange: (n: number) => void; canAdd: boolean; canRemove: boolean; onInfo: () => void; note?: string }) {
  const round = 'grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-white/[0.06] transition-colors hover:bg-white/[0.12] disabled:pointer-events-none disabled:opacity-35';
  return (
    <div className="panel flex items-center justify-between gap-4 p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-lg font-bold">{label}</p>
          <button type="button" onClick={onInfo} aria-label={`What is included in a ${label.toLowerCase()}`} className="grid h-7 w-7 place-items-center rounded-full border border-white/20 text-fog transition-colors hover:border-washo-400/60 hover:text-white"><Info className="h-4 w-4" /></button>
        </div>
        <p className="text-sm text-fog">{note ?? `${rupees(price)} per wash`}</p>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" disabled={!canRemove} onClick={() => onChange(value - 1)} aria-label={`One fewer ${label.toLowerCase()} per week`} className={round}><Minus className="h-5 w-5" /></button>
        <span aria-live="polite" aria-label={`${value} ${label.toLowerCase()} per week`} className="w-9 text-center font-display text-4xl font-extrabold tabular-nums">{value}</span>
        <button type="button" disabled={!canAdd} onClick={() => onChange(value + 1)} aria-label={`One more ${label.toLowerCase()} per week`} className={round}><Plus className="h-5 w-5" /></button>
      </div>
    </div>
  );
}

/** The total for one length option, e.g. "₹1,800 total · ₹600 / month". */
function DurationPrice({ vehicleType, pattern, months }: { vehicleType: VehicleType; pattern: { weekday: number; kind: WashKind }[]; months: number }) {
  const { data } = useEstimate({ vehicle_type: vehicleType, weekly_pattern: pattern, duration_months: months });
  if (!data) return <p className="mt-2 h-5 text-sm text-fog">…</p>;
  return <p className="mt-2 text-sm font-semibold tabular-nums">{rupees(data.final_cents)} <span className="font-normal text-fog">total · {rupees(Math.round(data.final_cents / months))} / month</span></p>;
}

/** Renewing: the link in the reminder email opens the wizard with the old plan filled in (vehicle, days, length, time), starting the day after it ends. */
export default function MembershipWizard() {
  const [params] = useSearchParams();
  const renewId = params.get('renew') ?? undefined;
  const renew = useMembership(renewId);
  if (renewId && renew.isLoading) return <div className="mx-auto max-w-3xl space-y-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;
  return <Wizard key={renew.data?.membership.id ?? 'new'} renewing={renewId ? renew.data?.membership : undefined} />;
}

function Wizard({ renewing }: { renewing?: Membership }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: catalog } = useCatalog();
  const { data: vehicles } = useVehicles();
  const { data: addresses } = useAddresses();
  const checkout = useStartMembershipPayment();
  const { pay, paying } = usePay();

  // Renewing starts from the old plan: the step the customer is most likely to change (the length) comes first.
  const oldPattern = renewing?.weekly_pattern ?? null;
  const [step, setStep] = useState(renewing && oldPattern ? 3 : 0);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  // How many Body washes and Deep cleans a week, then which weekdays each goes on.
  const [counts, setCounts] = useState<{ body: number; deep: number }>(() => {
    if (oldPattern?.length) return { body: oldPattern.filter((x) => x.kind === 'body').length, deep: oldPattern.filter((x) => x.kind === 'deep').length };
    const n = Number(params.get('perWeek'));
    return Number.isInteger(n) && n >= 1 && n <= MAX_PER_WEEK ? startingMix(n, params.get('type') === 'bike') : { body: 1, deep: 0 };
  });
  const [bodyDays, setBodyDays] = useState<number[]>(() => oldPattern?.filter((x) => x.kind === 'body').map((x) => x.weekday) ?? []);
  const [deepDays, setDeepDays] = useState<number[]>(() => oldPattern?.filter((x) => x.kind === 'deep').map((x) => x.weekday) ?? []);
  const [info, setInfo] = useState<WashKind | null>(null);
  // The weekday row paints one kind at a time: tap "Body washes" or "Deep cleans", then the days.
  const [paint, setPaint] = useState<WashKind>('body');
  // Exact dates, picked by hand instead of the automatic spread. Tied to the plan they were made for: change the plan and they are dropped.
  const [custom, setCustom] = useState<{ key: string; dates: ExactDate[] } | null>(null);
  const [exactOpen, setExactOpen] = useState(false);
  const [showAllDates, setShowAllDates] = useState(false);
  const [months, setMonths] = useState<number | null>(renewing?.duration_months ?? null);
  const [slot, setSlot] = useState<SlotId | null>(renewing?.time_slot ?? null);
  const [start, setStart] = useState<string | null>(() => (renewing ? [addDays(istDay(renewing.end_at), 1), addDays(todayIST(), 2)].sort().at(-1)! : null));
  const [addressId, setAddressId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [addrOpen, setAddrOpen] = useState(false);
  const [error, setError] = useState('');

  // Preselect from ?vehicle= (Vehicles page) or the only vehicle.
  useEffect(() => {
    if (vehicle || !vehicles?.length) return;
    const wanted = params.get('vehicle') ?? renewing?.vehicle_id ?? null;
    const wantedType = params.get('type');
    const v = vehicles.find((x) => x.id === wanted) ?? (wantedType ? vehicles.find((x) => x.vehicle_type === wantedType) : undefined) ?? (vehicles.length === 1 ? vehicles[0] : null);
    if (v) setVehicle(v);
  }, [vehicles, params, vehicle, renewing]);

  useEffect(() => {
    if (!addressId && addresses?.length) setAddressId((vehicle?.address_id && addresses.find((a) => a.id === vehicle.address_id)?.id) || addresses.find((a) => a.is_default)?.id || addresses[0].id);
  }, [addresses, vehicle, addressId]);

  const bike = vehicle?.vehicle_type === 'bike';
  const perWeek = counts.body + counts.deep;
  const minStart = addDays(todayIST(), 2);
  const address = addresses?.find((a) => a.id === addressId);
  const weeks = catalog?.weeks_per_month ?? 4;
  const total = months ? perWeek * weeks * months : 0;

  const vtype = vehicle?.vehicle_type;
  // The plan as the server wants it: one entry per wash, each on its own weekday.
  const pattern = useMemo(
    () => [...bodyDays.map((weekday) => ({ weekday, kind: 'body' as WashKind })), ...deepDays.map((weekday) => ({ weekday, kind: 'deep' as WashKind }))].sort((a, b) => a.weekday - b.weekday),
    [bodyDays, deepDays]
  );
  const planReady = Boolean(vtype && perWeek >= 1 && bodyDays.length === counts.body && deepDays.length === counts.deep);
  // Before the days are chosen, price a plain mix so the counters already show what each choice costs per month.
  const monthly = useEstimate(vtype && perWeek >= 1 ? { vehicle_type: vtype, weekly_pattern: planReady ? pattern : previewFor(counts.body, counts.deep), duration_months: 1 } : null);
  const planKey = JSON.stringify([vehicle?.id, pattern, months, start, slot]);
  const customActive = custom && custom.key === planKey ? custom.dates : null;
  const preview = usePlanPreview(vehicle && planReady && months && slot && start ? { vehicle_id: vehicle.id, weekly_pattern: pattern, duration_months: months, time_slot: slot, start_date: start } : null);
  const minLeadDays = catalog?.booking_rules?.membership_min_lead_days ?? 2;
  const earliest = addDays(todayIST(), minLeadDays);
  const termEnd = preview.data?.end_date;
  const { data: crowd } = useCapacity(earliest, termEnd && termEnd > addDays(earliest, 60) ? termEnd : addDays(earliest, 60), step >= 4);
  const customProblem = customActive && termEnd && start ? exactDatesProblem({ value: customActive, need: { body: counts.body * weeks * (months ?? 1), deep: counts.deep * weeks * (months ?? 1) }, perWeek, minDate: [start, earliest].sort().at(-1)!, end: termEnd, slot, crowd }) : null;
  const chosenEstimate = useEstimate(vtype && planReady && months ? { vehicle_type: vtype, weekly_pattern: pattern, duration_months: months } : null);

  const serviceName = (kind: WashKind) => {
    const code = catalog?.membership_options.find((o) => o.vehicle_type === vehicle?.vehicle_type && o.wash_kind === kind)?.service_code;
    return catalog?.services.find((s) => s.code === code)?.name ?? KIND_LABEL[kind];
  };
  const basePrice = (kind: WashKind): number => {
    const code = catalog?.membership_options.find((o) => o.vehicle_type === vehicle?.vehicle_type && o.wash_kind === kind)?.service_code;
    return catalog?.services.find((x) => x.code === code)?.unit_prices?.find((p) => p.vehicle_type === vehicle?.vehicle_type)?.price_cents ?? 0;
  };
  const washFor = (kind: WashKind) => {
    const code = catalog?.membership_options.find((o) => o.vehicle_type === vehicle?.vehicle_type && o.wash_kind === kind)?.service_code;
    return catalog?.services.find((x) => x.code === code);
  };
  // A customer whose free wash is done has a welcome offer in place of the normal frequency discount (never lower than it).
  const offer = useCampaign().data?.offer;
  const standard = (kind: 'frequency' | 'duration', key: number) => catalog?.discounts.find((d) => d.kind === kind && d.key === key)?.discount_bp ?? 0;
  const discount = (kind: 'frequency' | 'duration', key: number) => (kind === 'frequency' && offer ? Math.max(standard(kind, key), offerBpFor(offer, key)) : standard(kind, key));
  const offerApplies = (n: number) => Boolean(offer) && offerBpFor(offer!, n) > standard('frequency', n);

  // Changing a count trims the days already picked for that kind, never keeps more days than washes.
  const setCount = (kind: WashKind, n: number) => {
    const next = { ...counts, [kind]: Math.max(0, n) };
    if (next.body + next.deep < 1 || next.body + next.deep > MAX_PER_WEEK || (bike && next.deep > 0)) return;
    setCounts(next);
    setBodyDays((d) => d.slice(0, next.body));
    setDeepDays((d) => d.slice(0, next.deep));
  };

  // One weekday row. Tap a day to give it to the kind being painted; tap it again to take it off; tap a day of the other kind to move it over.
  const paintDay = (d: number) => {
    const other: WashKind = paint === 'body' ? 'deep' : 'body';
    const days = { body: bodyDays, deep: deepDays };
    const set = { body: setBodyDays, deep: setDeepDays };
    if (days[paint].includes(d)) return set[paint](days[paint].filter((x) => x !== d));
    if (days[paint].length >= counts[paint]) {
      if (days[other].length < counts[other]) setPaint(other); // this kind is done: carry on with the other
      return;
    }
    set[other](days[other].filter((x) => x !== d));
    set[paint]([...days[paint], d]);
    if (days[paint].length + 1 >= counts[paint] && days[other].filter((x) => x !== d).length < counts[other]) setPaint(other);
  };

  const canNext = [
    Boolean(vehicle),
    perWeek >= 1,
    planReady,
    Boolean(months),
    Boolean(slot && start) && (customActive ? !customProblem : preview.data?.fits !== false),
    Boolean(addressId),
  ][step];

  // Pay now: the server prices the plan from the rate card and opens the Razorpay order; the membership and its washes are
  // created only once the payment is verified.
  // Slide to pay: resolves only when the payment is verified (the handle then shows "Paid"); throws if it was not, so the handle springs back.
  const paidMembership = useRef<string | null>(null);
  const submit = async () => {
    if (!vehicle || !planReady || !months || !slot || !start) throw new Error('incomplete');
    setError('');
    let result;
    try {
      result = await pay(
        () => checkout.mutateAsync({
          vehicle_id: vehicle.id,
          weekly_pattern: pattern,
          duration_months: months,
          time_slot: slot,
          start_date: start,
          address_id: addressId,
          parking_location: address?.parking_location,
          customer_notes: notes.trim() || undefined,
          custom_dates: customActive ?? undefined,
        }),
        `WASHO membership · ${perWeek} per week · ${months} month${months > 1 ? 's' : ''}`
      );
    } catch (err) {
      // usePay reports payment problems itself; this covers plan problems the database refused (shown under the button)
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      throw err;
    }
    if (!result?.membership_id) throw new Error('not paid');
    paidMembership.current = result.membership_id;
  };
  const afterPaid = () => {
    setTimeout(() => navigate(`/app/membership/${paidMembership.current}?new=1`, { replace: true }), 1000);
  };

  const dir = useStepDirection(step);
  const slide = stepMotion(dir);

  return (
    <div className="mx-auto max-w-3xl pb-28">
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link to="/app/membership" className="inline-flex items-center gap-1.5 text-sm text-fog hover:text-white"><ArrowLeft className="h-4 w-4" /> Cancel</Link>
      </div>
      <WizardStepper steps={STEPS} step={step} onStep={setStep} />

      <AnimatePresence mode="wait" initial={false} custom={dir}>
        {step === 0 && (
          <motion.section key="s0" {...slide}>
            <h1 className="text-3xl font-extrabold">Which vehicle?</h1>
            <p className="mt-1.5 mb-6 text-fog">Your membership is for one vehicle. You can start another one later.</p>
            <VehiclePicker value={vehicle?.id ?? null} onChange={(v) => { setVehicle(v); setBodyDays([]); setDeepDays([]); if (v.vehicle_type === 'bike') setCounts(({ body, deep }) => ({ body: body + deep, deep: 0 })); }} />
          </motion.section>
        )}

        {step === 1 && (
          <motion.section key="s1" {...slide}>
            <h1 className="text-3xl font-extrabold">How many washes per week?</h1>
            <p className="mt-1.5 mb-6 text-fog">Choose how many {bike ? 'bike washes' : 'Body washes and how many Deep cleans'} you want each week, up to {MAX_PER_WEEK} in total. Tap <Info className="inline h-3.5 w-3.5 align-text-top" /> to see what each one includes.</p>

            <div className="space-y-3">
              <CountRow
                label={bike ? 'Bike wash' : KIND_LABEL.body}
                price={basePrice('body')}
                value={counts.body}
                onChange={(n) => setCount('body', n)}
                canAdd={perWeek < MAX_PER_WEEK}
                canRemove={counts.body > 0 && perWeek > 1}
                onInfo={() => setInfo('body')}
              />
              <CountRow
                label={KIND_LABEL.deep}
                price={basePrice('deep')}
                value={counts.deep}
                onChange={(n) => setCount('deep', n)}
                canAdd={!bike && perWeek < MAX_PER_WEEK}
                canRemove={counts.deep > 0 && perWeek > 1}
                onInfo={() => setInfo('deep')}
                note={bike ? 'Not offered for bikes' : undefined}
              />
            </div>

            <div className="glass mt-5 p-5" aria-live="polite">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-lg font-bold">{perWeek} wash{perWeek > 1 ? 'es' : ''} per week · {perWeek * weeks} a month</p>
                  <p className="mt-1 text-sm text-fog">
                    {[counts.body > 0 && `${counts.body} × ${bike ? 'Bike wash' : 'Body wash'}`, counts.deep > 0 && `${counts.deep} × Deep clean`].filter(Boolean).join(' + ')} each week
                  </p>
                  {discount('frequency', perWeek) > 0 && <Badge tone="yellow" className="mt-3" icon={<Sparkles className="h-3 w-3" />}>{percent(discount('frequency', perWeek))} off for {perWeek} per week{offerApplies(perWeek) ? ` · welcome offer, until ${shortDayIST(offer!.expires_at)}` : ''}</Badge>}
                </div>
                <div className="text-right">
                  <p className="eyebrow">Price</p>
                  <p className="font-display text-3xl font-extrabold tabular-nums">{monthly.data ? rupees(monthly.data.final_cents) : '…'}<span className="ml-1 text-sm font-medium text-fog">/ month</span></p>
                </div>
              </div>
              <p className="mt-4 border-t border-white/[0.07] pt-3 text-xs text-fog">
                Price per wash{vehicle ? ` for your ${vehicle.vehicle_type === 'suv' ? 'SUV' : vehicle.vehicle_type}` : ''}: {bike ? `Bike wash ${rupees(basePrice('body'))}` : `Body wash ${rupees(basePrice('body'))} · Deep clean ${rupees(basePrice('deep'))}`}.
              </p>
            </div>
          </motion.section>
        )}

        {step === 2 && (
          <motion.section key="s2" {...slide}>
            <h1 className="text-3xl font-extrabold">Pick your days</h1>
            <p className="mt-1.5 mb-6 text-fog">Just add your preferred days and we will manage your whole month accordingly.</p>

            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${counts.deep > 0 && counts.body > 0 ? 2 : 1}, minmax(0, 1fr))` }} role="group" aria-label="Which kind of wash you are placing">
              {(['body', 'deep'] as const).filter((k) => counts[k] > 0).map((k) => {
                const n = k === 'body' ? bodyDays.length : deepDays.length;
                const on = paint === k;
                return (
                  <button key={k} type="button" aria-pressed={on} onClick={() => setPaint(k)} className={cn('rounded-2xl border p-3.5 text-left transition-all', on ? (k === 'body' ? 'border-washo-400/70 bg-washo-500/20 shadow-[0_0_24px_-8px_rgb(63_124_255/0.7)]' : 'border-offer/60 bg-offer/15') : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20')}>
                    <span className="flex items-center gap-2 font-bold"><span className={cn('h-2.5 w-2.5 rounded-full', k === 'body' ? 'bg-washo-400' : 'bg-offer')} />{bike ? 'Bike washes' : k === 'body' ? 'Body washes' : 'Deep cleans'}</span>
                    <span className={cn('mt-0.5 block text-sm', n === counts[k] ? 'text-ok' : 'text-fog')}>{n === counts[k] ? 'All chosen' : `${n} of ${counts[k]} chosen`}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 grid grid-cols-7 gap-2" role="group" aria-label="Weekdays">
              {WEEKDAYS.map((d) => {
                const kind: WashKind | null = bodyDays.includes(d.id) ? 'body' : deepDays.includes(d.id) ? 'deep' : null;
                return (
                  <button key={d.id} type="button" aria-pressed={kind !== null} aria-label={`${d.long}${kind ? `, ${kind === 'body' ? 'Body wash' : 'Deep clean'}` : ''}`} onClick={() => paintDay(d.id)}
                    className={cn('flex h-[4.5rem] flex-col items-center justify-center rounded-2xl border text-sm font-bold transition-all', kind === 'body' ? 'border-washo-400 bg-washo-500 text-white' : kind === 'deep' ? 'border-offer bg-offer text-ink-950' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/25')}>
                    {d.short}
                    <span className={cn('mt-0.5 text-[9px] font-semibold uppercase', kind ? 'opacity-80' : 'text-fog')}>{kind === 'body' ? (bike ? 'Wash' : 'Body') : kind === 'deep' ? 'Deep' : 'tap'}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-fog">Tap a day to give it a {paint === 'body' ? (bike ? 'bike wash' : 'Body wash') : 'Deep clean'}. Tap it again to take it off. A day can have one wash. {perWeek} per week in all.</p>

            {pattern.length > 0 && (
              <div className="panel mt-5 divide-y divide-white/[0.07]">
                {pattern.map((p) => (
                  <div key={p.weekday} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                    <span className="font-semibold">{WEEKDAYS[p.weekday].long}</span>
                    <span className="flex items-center gap-2 text-mist"><span className={cn('h-2 w-2 rounded-full', p.kind === 'body' ? 'bg-washo-400' : 'bg-offer')} />{serviceName(p.kind)}</span>
                  </div>
                ))}
              </div>
            )}
            {planReady && monthly.data && <p className="mt-4 text-sm text-mist">Price for this plan: <span className="font-bold text-white">{rupees(monthly.data.final_cents)}</span> a month.</p>}
            {planReady && <p className="mt-2 text-xs text-fog">Your washes follow these days through the whole membership. If a day is fully booked, that wash moves to your next chosen day. You can pick exact dates instead on the next steps.</p>}
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
          </motion.section>
        )}

        {step === 4 && (
          <motion.section key="s4" {...slide}>
            <h1 className="text-3xl font-extrabold">When should we start?</h1>
            <p className="mt-1.5 mb-6 text-fog">Your washes run on your chosen days at this time. The first wash is the first of those days on or after your start date.</p>
            <DateSlotPicker date={start} slot={slot} onDate={setStart} onSlot={setSlot} min={minStart} days={start ? Math.max(21, Math.round((Date.parse(start) - Date.parse(minStart)) / 86_400_000) + 8) : 21} label="start date" crowd={crowd} />

            {start && slot && (
              <div className="mt-8 space-y-4">
                {preview.isError && <p role="alert" className="flex items-start gap-2 text-sm text-warn"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {(preview.error as Error).message}</p>}
                {preview.data && !customActive && !preview.data.fits && (
                  <p role="alert" className="flex items-start gap-2 rounded-2xl border border-bad/30 bg-bad/10 p-4 text-sm text-bad"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Your chosen days are too crowded to fit all {preview.data.total} washes before your membership ends. Choose other days, another time window or a later start, or pick exact dates below.</p>
                )}
                {preview.data && !customActive && preview.data.fits && preview.data.dates.some((d) => d.state === 'busy') && (
                  <p className="flex items-start gap-2 rounded-2xl border border-warn/30 bg-warn/10 p-4 text-sm text-warn"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Some of your days are busy. Your washes are still booked, but a busy day can be harder to reschedule.</p>
                )}

                <div className="glass overflow-hidden">
                  <button type="button" aria-expanded={exactOpen} onClick={() => {
                    const next = !exactOpen;
                    setExactOpen(next);
                    if (next && !customActive && preview.data) setCustom({ key: planKey, dates: preview.data.dates.map(({ date, kind }) => ({ date, kind })) });
                  }} className="flex w-full items-center justify-between gap-3 p-4 text-left">
                    <span>
                      <span className="block font-bold">Want to pick exact dates?</span>
                      <span className="block text-sm text-fog">{customActive ? 'You are using exact dates.' : 'Choose every wash yourself on a calendar, instead of the automatic spread.'}</span>
                    </span>
                    <ChevronDown className={cn('h-5 w-5 shrink-0 text-fog transition-transform', exactOpen && 'rotate-180')} />
                  </button>
                  {exactOpen && (
                    <div className="border-t border-white/[0.07] p-4">
                      {customActive && termEnd ? (
                        <ExactDatesCalendar
                          start={start} end={termEnd} minDate={[start, earliest].sort().at(-1)!} need={{ body: counts.body * weeks * (months ?? 1), deep: counts.deep * weeks * (months ?? 1) }} perWeek={perWeek}
                          value={customActive} onChange={(dates) => setCustom({ key: planKey, dates })} crowd={crowd} slot={slot}
                          onReset={() => { setCustom(null); setExactOpen(false); }}
                        />
                      ) : <Skeleton className="h-48" />}
                    </div>
                  )}
                </div>

                {!exactOpen && preview.data && (
                  <div>
                    <p className="eyebrow">Your washes will be on</p>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {preview.data.dates.slice(0, showAllDates ? undefined : 10).map((d) => (
                        <li key={d.date} className={cn('rounded-full border px-2.5 py-1 text-xs font-semibold', d.kind === 'body' ? 'border-washo-400/40 bg-washo-500/15' : 'border-offer/40 bg-offer/10', d.state === 'busy' && 'ring-1 ring-warn/60')}>{prettyDate(d.date)}</li>
                      ))}
                    </ul>
                    {preview.data.dates.length > 10 && <button type="button" onClick={() => setShowAllDates(!showAllDates)} className="mt-2 text-sm font-semibold text-washo-300 hover:text-white">{showAllDates ? 'Show fewer' : `Show all ${preview.data.dates.length}`}</button>}
                  </div>
                )}
              </div>
            )}
          </motion.section>
        )}

        {step === 5 && vehicle && perWeek && months && slot && start && (
          <motion.section key="s5" {...slide}>
            <h1 className="text-3xl font-extrabold">Review and pay</h1>
            <p className="mt-1.5 mb-6 text-fog">Check your plan, then pay securely. Your washes are scheduled as soon as the payment is verified.</p>
            <div className="glass divide-y divide-white/[0.07]">
              <div className="flex items-center justify-between gap-4 p-5"><div><p className="eyebrow">Vehicle</p><p className="mt-1 font-bold">{vehicle.make ? `${vehicle.make} ` : ''}{vehicle.model}</p></div><Plate reg={vehicle.registration_number} /></div>
              <div className="p-5">
                <p className="eyebrow">Weekly schedule · {perWeek} per week</p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {pattern.map((p) => (<li key={p.weekday} className="flex justify-between gap-3"><span>{WEEKDAYS[p.weekday].long}</span><span className="text-mist">{serviceName(p.kind)}</span></li>))}
                </ul>
              </div>
              <div className="grid grid-cols-2 gap-4 p-5 text-sm">
                <div><p className="eyebrow">Length</p><p className="mt-1 font-semibold">{months} month{months > 1 ? 's' : ''} · {total} washes</p></div>
                <div><p className="eyebrow">Time</p><p className="mt-1 font-semibold">{slotLabel(slot)}</p></div>
                <div><p className="eyebrow">Starting</p><p className="mt-1 font-semibold">{prettyDate(start)}</p></div>
                <div>
                  <p className="eyebrow">Discounts</p>
                  <p className="mt-1 font-semibold">{[discount('frequency', perWeek) ? `${percent(discount('frequency', perWeek))} ${offerApplies(perWeek) ? 'welcome offer' : 'frequency'}` : '', discount('duration', months) ? `${percent(discount('duration', months))} length` : ''].filter(Boolean).join(' + ') || 'None for this plan'}</p>
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
            {(customActive ?? preview.data?.dates) && (
              <div className="glass mt-5 p-5">
                <div className="flex items-baseline justify-between gap-3"><h2 className="font-bold">Your schedule</h2><p className="text-xs text-fog">{customActive ? 'Exact dates you chose' : 'On your chosen days'} · {(customActive ?? preview.data!.dates).length} washes</p></div>
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {(customActive ?? preview.data!.dates).slice(0, showAllDates ? undefined : 12).map((d) => (
                    <li key={d.date} className={cn('rounded-full border px-2.5 py-1 text-xs font-semibold', d.kind === 'body' ? 'border-washo-400/40 bg-washo-500/15' : 'border-offer/40 bg-offer/10')}>{prettyDate(d.date)} · {d.kind === 'body' ? (bike ? 'Wash' : 'Body') : 'Deep'}</li>
                  ))}
                </ul>
                {(customActive ?? preview.data!.dates).length > 12 && <button type="button" onClick={() => setShowAllDates(!showAllDates)} className="mt-2 text-sm font-semibold text-washo-300 hover:text-white">{showAllDates ? 'Show fewer' : `Show all ${(customActive ?? preview.data!.dates).length}`}</button>}
              </div>
            )}
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
            <SlideToPay label={`Slide to pay ${chosenEstimate.data ? rupees(chosenEstimate.data.final_cents) : ''}`.trim()} disabled={!canNext || !chosenEstimate.data || checkout.isPending || paying} onConfirm={submit} onDone={afterPaid} />
          )}
        </div>
      </div>
      <Sheet open={info !== null} onClose={() => setInfo(null)} size="sm" title={info ? `What is in a ${bike && info === 'body' ? 'bike wash' : KIND_LABEL[info].toLowerCase()}?` : ''}
        description={info ? [serviceName(info), washFor(info)?.duration_minutes ? `about ${duration(washFor(info)!.duration_minutes!)}` : null, `${rupees(basePrice(info))} per wash`].filter(Boolean).join(' · ') : undefined}
        footer={<Button full variant="glass" onClick={() => setInfo(null)}>Got it</Button>}>
        {info && (
          <div className="space-y-4">
            {washFor(info)?.tagline && <p className="font-semibold text-mist">{washFor(info)!.tagline}</p>}
            {washFor(info)?.includes?.length ? (
              <ul className="space-y-2.5 text-sm">
                {washFor(info)!.includes!.map((i) => <li key={i} className="flex items-start gap-2.5"><Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" strokeWidth={3} /> {i}</li>)}
              </ul>
            ) : <p className="text-sm text-fog">{washFor(info)?.description ?? 'Ask your specialist what is included.'}</p>}
            {vehicle?.vehicle_type === 'suv' && <p className="text-xs text-fog">For an SUV the Body wash is the car Body wash and the Deep clean is the SUV Deep clean, so the Deep clean costs more.</p>}
          </div>
        )}
      </Sheet>
      <AddressSheet open={addrOpen} onClose={() => setAddrOpen(false)} onSaved={(a) => setAddressId(a.id)} />
    </div>
  );
}
