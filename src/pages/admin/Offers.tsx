import { Gift, Pencil, Percent, Plus, Power, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { OfferStrip } from '../../components/OfferBanner';
import { Badge, type Tone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { prettyDate } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useAdminAction, useAdminOffers } from '../../lib/queries';
import type { AdminOffer, OfferKind } from '../../lib/types';
import { ConfirmSheet, Loading, errText } from './shared';

const KIND: Record<OfferKind, string> = { discount: 'Discount', complimentary_wash: 'Complimentary wash' };
const STATE: Record<AdminOffer['status'], { label: string; tone: Tone }> = {
  live: { label: 'Showing now', tone: 'green' },
  off: { label: 'Switched off', tone: 'slate' },
  scheduled: { label: 'Starts later', tone: 'blue' },
  ended: { label: 'Ended', tone: 'amber' },
};
const HINT: Record<OfferKind, string> = { discount: 'Extra 10% off memberships', complimentary_wash: 'Your first wash is on us' };

interface Form { kind: OfferKind; headline: string; details: string; code: string; from: string; to: string; on: boolean }
const blank: Form = { kind: 'discount', headline: '', details: '', code: '', from: '', to: '', on: false };

function OfferSheet({ open, offer, onClose }: { open: boolean; offer: AdminOffer | null; onClose: () => void }) {
  const act = useAdminAction();
  const toast = useToast();
  const [f, setF] = useState<Form>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    setErrors({});
    setF(offer ? { kind: offer.kind, headline: offer.headline, details: offer.details ?? '', code: offer.code ?? '', from: offer.starts_on ?? '', to: offer.ends_on ?? '', on: offer.is_active } : blank);
  }, [offer, open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    const body = { kind: f.kind, headline: f.headline, details: f.details.trim() || null, code: f.kind === 'discount' ? f.code.trim().toUpperCase() || null : null, starts_on: f.from || null, ends_on: f.to || null, active: f.on };
    try {
      await act.mutateAsync(offer ? { method: 'PUT', path: `offers/${offer.id}`, body } : { path: 'offers', body });
      toast.success(offer ? 'Offer saved' : f.on ? 'Offer created. It is on the site and the app now.' : 'Offer created. Switch it on when you are ready.');
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields); else toast.error(errText(err));
    }
  };

  return (
    <Sheet open={open} onClose={onClose} size="md" title={offer ? 'Edit offer' : 'New offer'} description="A short line that shows at the top of the website and on the app's Home screen while it is switched on."
      footer={<Button type="submit" form="offer-form" full size="lg" loading={act.isPending}>{offer ? 'Save offer' : 'Create offer'}</Button>}>
      <form id="offer-form" onSubmit={submit} className="space-y-5" noValidate>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-mist">What kind of offer is it?</p>
          <Segmented label="Kind of offer" value={f.kind} onChange={(kind) => setF({ ...f, kind, code: kind === 'discount' ? f.code : '' })} options={[{ value: 'discount', label: 'Discount' }, { value: 'complimentary_wash', label: 'Complimentary wash' }]} />
          {errors.kind && <p className="mt-1 text-xs text-bad">{errors.kind}</p>}
        </div>
        <Input label="The offer" value={f.headline} error={errors.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} maxLength={60} placeholder={HINT[f.kind]} hint="Up to 60 characters." required />
        <Input label="A line of detail" optional value={f.details} error={errors.details} onChange={(e) => setF({ ...f, details: e.target.value })} maxLength={140} placeholder="This week only" hint="Shown after the offer on wider screens." />
        {f.kind === 'discount' && (
          <Input label="Coupon code to show" optional value={f.code} error={errors.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} maxLength={20} placeholder="EXTRA10"
            hint="A code you made under Discounts. It is only shown while that coupon works. The discount itself comes from the coupon." />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="First day" type="date" optional value={f.from} error={errors.starts_on} onChange={(e) => setF({ ...f, from: e.target.value })} hint="Empty: from the moment it is on." />
          <Input label="Last day" type="date" optional value={f.to} min={f.from || undefined} error={errors.ends_on} onChange={(e) => setF({ ...f, to: e.target.value })} hint="Empty: until you switch it off." />
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-mist">Show it on the website and the app?</p>
          <Segmented label="Show it" value={f.on ? 'on' : 'off'} onChange={(v) => setF({ ...f, on: v === 'on' })} options={[{ value: 'off', label: 'Not yet' }, { value: 'on', label: 'Yes, show it' }]} />
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-mist">How it looks on the website</p>
          <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-ink-950">
            <OfferStrip offer={{ kind: f.kind, headline: f.headline.trim() || HINT[f.kind], details: f.details.trim() || null, code: f.kind === 'discount' ? f.code || null : null }} />
          </div>
        </div>
      </form>
    </Sheet>
  );
}

/** "Offers on the home screen": a discount or a complimentary wash, switched on here, shows on the website and in the app at once. */
export default function Offers() {
  const { data, isLoading, isError, error, refetch } = useAdminOffers();
  const act = useAdminAction();
  const toast = useToast();
  const [editing, setEditing] = useState<AdminOffer | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminOffer | null>(null);

  const toggle = async (o: AdminOffer) => {
    try { await act.mutateAsync({ path: `offers/${o.id}/active`, body: { active: !o.is_active } }); toast.success(o.is_active ? 'Switched off. It is gone from the site and the app.' : 'Switched on. It is on the site and the app now.'); } catch (e) { toast.error(errText(e)); }
  };
  const remove = async () => {
    if (!deleting) return;
    try { await act.mutateAsync({ path: `offers/${deleting.id}/delete`, body: {} }); toast.success('Offer deleted'); } catch (e) { toast.error(errText(e)); }
    setDeleting(null);
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Offer on the home screen</h2>
          <p className="max-w-xl text-sm text-fog">Switch an offer on and it shows in a strip at the top of the website and at the top of Home in the app. Switch it off and it goes. It tells people about a discount or a free wash; the price itself comes from Discounts and Campaigns.</p>
        </div>
        <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>New offer</Button>
      </div>
      {isError ? <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} /> : isLoading || !data ? <Loading /> : !data.length ? (
        <div className="panel p-6 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-washo-500/15 text-washo-300"><Percent className="h-5 w-5" /></span>
          <p className="mt-3 font-semibold">No offers yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-fog">Make one, for example “Extra 10% off memberships” or “Your first wash is on us”, and switch it on.</p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.map((o) => {
            const st = STATE[o.status];
            return (
              <div key={o.id} className="glass p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fog">{o.kind === 'discount' ? <Percent className="h-3.5 w-3.5" /> : <Gift className="h-3.5 w-3.5" />}{KIND[o.kind]}</p>
                    <p className="mt-1 break-words font-bold">{o.headline}</p>
                    {o.details && <p className="text-sm text-fog">{o.details}</p>}
                    <p className="mt-1 text-xs text-fog">
                      {o.code ? <>Code <span className="font-mono font-bold text-mist">{o.code}</span>{o.code_works === false ? ' (this coupon is off or used up, so the code is hidden)' : ''} · </> : null}
                      {o.starts_on || o.ends_on ? `${o.starts_on ? prettyDate(o.starts_on) : 'now'} to ${o.ends_on ? prettyDate(o.ends_on) : 'switched off'}` : 'No dates: until switched off'}
                    </p>
                  </div>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant={o.is_active ? 'danger' : 'primary'} icon={<Power className="h-4 w-4" />} loading={act.isPending} onClick={() => void toggle(o)}>{o.is_active ? 'Switch off' : 'Switch on'}</Button>
                  <Button size="sm" variant="glass" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(o)}>Edit</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} aria-label={`Delete ${o.headline}`} onClick={() => setDeleting(o)}>Delete</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <OfferSheet open={Boolean(editing)} offer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      <ConfirmSheet open={Boolean(deleting)} onClose={() => setDeleting(null)} loading={act.isPending} tone="danger" confirmLabel="Delete offer" title={`Delete “${deleting?.headline ?? 'this offer'}”?`}
        description="It leaves the website and the app for good. Prices, coupons and campaigns are not touched. (The change is written to the activity log.)" onConfirm={() => void remove()} />
    </section>
  );
}
