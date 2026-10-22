import { Bike, Car, Check, MapPin, Tag, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { COLOURS } from '../../lib/colours';
import { rupees } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { pausedBlocker, phoneBlocker } from '../../lib/payBlockers';
import { usePublicSettings, useSaveAddress, useSaveVehicle, useStartMembershipPayment, useStartOnDemandPayment } from '../../lib/queries';
import { useNeedsPhone } from '../../lib/useNeedsPhone';
import { usePay } from '../../lib/usePay';
import type { AddressCardData, AgentCard, AgentEvent, MembershipCardData, SingleWashCardData, VehicleCardData } from '../../lib/agent';
import { PayPhoneGate } from '../PayPhoneGate';
import { SlideToPay } from '../SlideToPay';

/**
 * What Woshi puts in the chat when something has to be confirmed. Every figure on a card was worked out by the server from the rate card; the customer saves a vehicle with a tap, and
 * pays with the same slide-to-pay and the same payment calls as the booking pages (the server prices and checks everything again at that moment).
 */
export interface CardActions {
  event: (ev: AgentEvent) => Promise<void> | void;
  markDone: (cardId: string, done: 'saved' | 'paid') => void;
  /** Put a coupon on a pay card, or take it off (null). The server prices the card again; a code it refuses throws its reason. */
  coupon: (cardId: string, code: string | null) => Promise<void>;
}

const expired = (c: AgentCard) => new Date(c.expires_at).getTime() < Date.now();

const frame = 'rounded-2xl border border-white/[0.1] bg-white/[0.04] p-4';
const input = 'h-11 w-full rounded-xl border border-white/[0.12] bg-white/[0.04] px-3 text-sm text-white outline-none transition-colors placeholder:text-fog focus:border-washo-400/70';

function Done({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 text-sm font-semibold text-ok"><Check className="h-4 w-4" aria-hidden /> {children}</p>
  );
}

function Money({ lines }: { lines: { label: string; cents: number; tone: string }[] }) {
  return (
    <div className="mt-3 space-y-1.5 border-t border-white/[0.08] pt-3 text-sm">
      {lines.map((l, i) => (
        <div key={i} className={cn('flex justify-between gap-3', l.tone === 'total' && 'pt-1.5 font-display text-base font-extrabold', l.tone === 'discount' && 'text-ok')}>
          <span className={cn(l.tone === 'plain' && 'text-fog')}>{l.label}</span>
          <span className="font-sans tabular-nums">{l.cents < 0 ? '−' : ''}{rupees(Math.abs(l.cents))}</span>
        </div>
      ))}
    </div>
  );
}

function Rows({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="mt-3 space-y-1.5 text-sm">
      {rows.map((r) => (
        <div key={r.label} className="flex justify-between gap-4">
          <dt className="shrink-0 text-fog">{r.label}</dt>
          <dd className="text-right font-medium">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function VehicleCard({ card, a }: { card: VehicleCardData; a: CardActions }) {
  const save = useSaveVehicle();
  const [f, setF] = useState(card.fields);
  const [error, setError] = useState('');
  const stale = expired(card);
  if (card.done === 'saved') return <div className={frame}><Done>Vehicle saved</Done><p className="mt-1 text-sm text-fog">{[f.make, f.model].filter(Boolean).join(' ')} · {f.registration_number}</p></div>;
  const submit = async () => {
    setError('');
    try {
      const v = await save.mutateAsync({ vehicle_type: f.vehicle_type, make: f.make.trim() || undefined, model: f.model.trim(), registration_number: f.registration_number.replace(/\s+/g, ''), color: f.color.trim(), address_id: f.address_id });
      a.markDone(card.id, 'saved');
      void a.event({ type: 'vehicle_saved', vehicle_id: v.id, card_id: card.id });
    } catch (err) {
      setError(err instanceof ApiError ? Object.values(err.fields)[0] ?? err.message : 'Could not save. Please try again.');
    }
  };
  const types = [['car', 'Car', Car], ['bike', 'Bike', Bike], ['suv', 'SUV', Car]] as const;
  return (
    <div className={frame}>
      <p className="font-bold">Save this vehicle?</p>
      <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Vehicle type">
        {types.map(([id, label, Icon]) => (
          <button key={id} type="button" role="radio" aria-checked={f.vehicle_type === id} onClick={() => setF({ ...f, vehicle_type: id })} className={cn('flex h-11 items-center justify-center gap-1.5 rounded-xl border text-sm font-semibold transition-colors', f.vehicle_type === id ? 'border-washo-400/70 bg-washo-500/20' : 'border-white/[0.1] bg-white/[0.03] text-fog hover:text-white')}>
            <Icon className="h-4 w-4" aria-hidden /> {label}
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <input className={input} value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} placeholder="Make (Hyundai)" aria-label="Make" maxLength={60} />
        <input className={input} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="Model (Creta)" aria-label="Model" maxLength={60} />
      </div>
      <input className={cn(input, 'mt-2 font-mono uppercase tracking-wider')} value={f.registration_number} onChange={(e) => setF({ ...f, registration_number: e.target.value.toUpperCase() })} placeholder="MH12AB1234" aria-label="Registration number" maxLength={20} />
      <input className={cn(input, 'mt-2')} value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} placeholder="Colour (White, Silver, Red)" aria-label="Colour" maxLength={30} />
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Common colours">
        {COLOURS.map((c) => (
          <button key={c} type="button" aria-pressed={f.color.trim().toLowerCase() === c.toLowerCase()} onClick={() => setF({ ...f, color: c })} className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors', f.color.trim().toLowerCase() === c.toLowerCase() ? 'border-washo-400/70 bg-washo-500/20' : 'border-white/10 text-fog hover:text-white')}>{c}</button>
        ))}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-bad">{error}</p>}
      {stale ? <p className="mt-3 text-sm text-fog">This card has expired. Ask Woshi again.</p> : (
        <button type="button" onClick={() => void submit()} disabled={save.isPending || !f.model.trim() || f.registration_number.trim().length < 4 || !f.color.trim()} className="mt-3 h-11 w-full rounded-2xl bg-gradient-to-b from-washo-500 to-washo-700 text-sm font-semibold text-white disabled:opacity-50">
          {save.isPending ? 'Saving…' : 'Save vehicle'}
        </button>
      )}
    </div>
  );
}

function AddressCard({ card, a }: { card: AddressCardData; a: CardActions }) {
  const save = useSaveAddress();
  const [f, setF] = useState(card.fields);
  const [error, setError] = useState('');
  const stale = expired(card);
  if (card.done === 'saved') return <div className={frame}><Done>Address saved</Done><p className="mt-1 text-sm text-fog">{f.society_name}, {f.building_block} {f.flat_number}</p></div>;
  const submit = async () => {
    setError('');
    try {
      const saved = await save.mutateAsync({ label: f.label, society_name: f.society_name.trim(), building_block: f.building_block.trim(), flat_number: f.flat_number.trim(), parking_location: f.parking_location.trim(), area_locality: f.area_locality, city: f.city, pincode: f.pincode });
      a.markDone(card.id, 'saved');
      void a.event({ type: 'address_saved', address_id: saved.id, card_id: card.id });
    } catch (err) {
      setError(err instanceof ApiError ? Object.values(err.fields)[0] ?? err.message : 'Could not save. Please try again.');
    }
  };
  const field = (key: 'society_name' | 'building_block' | 'flat_number' | 'parking_location', label: string, ph: string) => (
    <input className={input} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} placeholder={ph} aria-label={label} maxLength={160} />
  );
  return (
    <div className={frame}>
      <p className="flex items-center gap-2 font-bold"><MapPin className="h-4 w-4 text-washo-300" aria-hidden /> Save this address?</p>
      <div className="mt-3 space-y-2">
        {field('society_name', 'Society or building', 'Society')}
        <div className="grid grid-cols-2 gap-2">{field('building_block', 'Block or wing', 'Block / wing')}{field('flat_number', 'Flat number', 'Flat')}</div>
        {field('parking_location', 'Where the vehicle is parked', 'Parking spot')}
        <p className="text-xs text-fog">{f.area_locality}, {f.city} {f.pincode}</p>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-bad">{error}</p>}
      {stale ? <p className="mt-3 text-sm text-fog">This card has expired. Ask Woshi again.</p> : (
        <button type="button" onClick={() => void submit()} disabled={save.isPending || !f.society_name.trim() || !f.building_block.trim() || !f.flat_number.trim() || f.parking_location.trim().length < 2} className="mt-3 h-11 w-full rounded-2xl bg-gradient-to-b from-washo-500 to-washo-700 text-sm font-semibold text-white disabled:opacity-50">
          {save.isPending ? 'Saving…' : 'Save address'}
        </button>
      )}
    </div>
  );
}

/**
 * "Have a coupon?" on a pay card. The code goes to the server, which asks the database whether this customer can use it for this purchase and sends the card back priced again (the coupon
 * as its own line); or says in plain words why not, and the card stays as it was. The payment checks the coupon once more.
 */
function CardCoupon({ card, a, onBusy }: { card: SingleWashCardData | MembershipCardData; a: CardActions; onBusy: (busy: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const applied = card.pay.coupon;
  // tapping "Have a coupon?" is asking to type one: the cursor is in the box
  useEffect(() => { if (open) box.current?.focus(); }, [open]);
  const run = async (code: string | null) => {
    setError('');
    setBusy(true);
    onBusy(true);
    try {
      await a.coupon(card.id, code);
      setText('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  if (applied) {
    return (
      <div className="mt-3 flex items-center justify-between gap-3 text-sm">
        <p className="flex items-center gap-2"><Tag className="h-4 w-4 text-ok" aria-hidden /> <span className="font-bold">{applied}</span> <span className="text-ok">applied</span></p>
        <button type="button" disabled={busy} onClick={() => void run(null)} className="inline-flex items-center gap-1 font-semibold text-washo-300 hover:text-white disabled:opacity-50"><X className="h-4 w-4" aria-hidden /> Remove</button>
      </div>
    );
  }
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-washo-300 hover:text-white"><Tag className="h-4 w-4" aria-hidden /> Have a coupon?</button>;
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 3) void run(text.trim()); }} className="mt-3">
      <div className="flex items-center gap-2">
        <input
          ref={box}
          className={cn(input, 'min-w-0 flex-1 font-mono uppercase tracking-wider')}
          value={text}
          onChange={(e) => { setText(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20)); setError(''); }}
          placeholder="Coupon code"
          aria-label="Coupon code"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={busy || text.trim().length < 3} className="h-11 shrink-0 rounded-xl border border-washo-400/40 bg-washo-500/10 px-4 text-sm font-semibold text-washo-100 transition-colors hover:bg-washo-500/25 disabled:opacity-50">{busy ? 'Checking…' : 'Apply'}</button>
      </div>
      {error && <p role="alert" className="mt-1.5 text-sm text-bad">{error}</p>}
    </form>
  );
}

/** The booking card and the plan card: the details, the exact price, and the slide to pay. */
function PayCard({ card, a }: { card: SingleWashCardData | MembershipCardData; a: CardActions }) {
  const { pay, paying } = usePay();
  const single = useStartOnDemandPayment();
  const plan = useStartMembershipPayment();
  const needsPhone = useNeedsPhone();
  const paused = usePublicSettings().data;
  const paid = useRef<{ kind: 'single' | 'membership'; id: string } | null>(null);
  const cancelled = useRef(false);
  const [pricing, setPricing] = useState(false); // a coupon is being checked: the price is about to change, so not now
  const stale = expired(card);

  if (card.done === 'paid') return <div className={frame}><Done>Paid</Done><p className="mt-1 text-sm text-fog">{card.title}</p></div>;

  const submit = async () => {
    const result = await pay(
      () => (card.type === 'single_wash' ? single.mutateAsync(card.pay) : plan.mutateAsync({ ...card.pay, monthly: { ...card.pay.monthly } })),
      card.type === 'single_wash' ? `${card.title} · ${card.rows.find((r) => r.label === 'When')?.value ?? ''}` : `WASHO membership · ${card.title}`
    );
    const id = card.type === 'single_wash' ? result?.booking_id : result?.membership_id;
    if (!result || !id) {
      // closed or failed: say so once in the chat (the reason was already shown at the top of the screen)
      if (!cancelled.current) { cancelled.current = true; void a.event({ type: 'payment_cancelled' }); }
      throw new Error('not paid');
    }
    paid.current = { kind: card.type === 'single_wash' ? 'single' : 'membership', id };
  };
  const afterPaid = () => {
    if (!paid.current) return;
    a.markDone(card.id, 'paid');
    void a.event({ type: 'paid', kind: paid.current.kind, id: paid.current.id, card_id: card.id });
  };

  return (
    <div className={frame}>
      <p className="font-bold">{card.title}</p>
      {card.description && <p className="text-sm text-fog">{card.description}</p>}
      <Rows rows={card.rows} />
      <Money lines={card.lines} />
      {card.type === 'membership' && <p className="mt-1 text-right text-xs text-fog">{rupees(card.per_month_cents)} a month</p>}
      {stale ? (
        <p className="mt-3 text-sm text-fog">This card has expired, because prices and free days can change. Ask Woshi to show it again.</p>
      ) : (
        <>
          <CardCoupon card={card} a={a} onBusy={setPricing} />
          {needsPhone && <PayPhoneGate />}
          <div className="mt-4 flex">
            <SlideToPay label={`Slide to pay ${rupees(card.total_cents)}`} disabled={paying || pricing || single.isPending || plan.isPending} blockers={[...pausedBlocker(paused), ...phoneBlocker(needsPhone)]} onConfirm={submit} onDone={afterPaid} />
          </div>
          <p className="mt-2 text-xs text-fog">The price is set by WASHO's rate card. Your booking is confirmed once the payment is verified.</p>
        </>
      )}
    </div>
  );
}

export function AgentCards({ cards, actions }: { cards: AgentCard[]; actions: CardActions }) {
  return (
    <div className="mt-2 space-y-2.5">
      {cards.map((c) =>
        c.type === 'vehicle' ? <VehicleCard key={c.id} card={c} a={actions} />
        : c.type === 'address' ? <AddressCard key={c.id} card={c} a={actions} />
        : <PayCard key={c.id} card={c} a={actions} />
      )}
    </div>
  );
}
