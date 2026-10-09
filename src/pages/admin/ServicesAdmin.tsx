import { Archive, ArchiveRestore, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select, TextArea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { duration, rupees, vehicleLabel } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useAdminAction, useAdminPricing, useAdminServices } from '../../lib/queries';
import type { AdminService, VehicleType } from '../../lib/types';
import { ConfirmSheet, Loading, errText, percentToBp, rupeesToCents } from './shared';

// ───────────────────────── a service ─────────────────────────
function ServiceSheet({ open, service, onClose }: { open: boolean; service: AdminService | null; onClose: () => void }) {
  const act = useAdminAction();
  const toast = useToast();
  const blank = { code: '', name: '', vehicle_type: 'car' as VehicleType, description: '', tagline: '', duration: '', includes: '', sort_order: '100' };
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    setErrors({});
    setF(service ? { code: service.code, name: service.name, vehicle_type: service.vehicle_type, description: service.description ?? '', tagline: service.tagline ?? '', duration: service.duration_minutes ? String(service.duration_minutes) : '', includes: service.includes.join('\n'), sort_order: String(service.sort_order) } : blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    const body = {
      name: f.name, description: f.description || undefined, tagline: f.tagline || undefined,
      duration_minutes: f.duration ? Number(f.duration) : null,
      includes: f.includes.split('\n').map((l) => l.trim()).filter(Boolean), sort_order: Number(f.sort_order) || 0,
    };
    try {
      await act.mutateAsync(service ? { method: 'PUT', path: `services/${service.id}`, body } : { path: 'services', body: { ...body, code: f.code, vehicle_type: f.vehicle_type } });
      toast.success(service ? 'Service saved' : 'Service added. Give it a price so customers can book it.');
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields); else toast.error(errText(err));
    }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <Sheet open={open} onClose={onClose} size="lg" title={service ? `Edit ${service.name}` : 'Add a service'} description={service ? undefined : 'A single wash customers can book. Memberships keep using the Body and Deep services they are built from.'}
      footer={<Button type="submit" form="service-form" full size="lg" loading={act.isPending}>{service ? 'Save service' : 'Add service'}</Button>}>
      <form id="service-form" onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Name" value={f.name} error={errors.name} onChange={set('name')} required />
          {service ? (
            <Input label="Code" value={f.code} disabled hint="The code and vehicle type cannot be changed." />
          ) : (
            <Input label="Code" value={f.code} error={errors.code} onChange={set('code')} placeholder="bike-polish" hint="Short, lowercase, dashes. Fixed once created." required />
          )}
          {!service && (
            <Select label="For" value={f.vehicle_type} onChange={(e) => setF({ ...f, vehicle_type: e.target.value as VehicleType })} hint="A car service is also offered to SUVs.">
              {(['bike', 'car', 'suv'] as VehicleType[]).map((v) => <option key={v} value={v}>{vehicleLabel[v]}</option>)}
            </Select>
          )}
          <Input label="Takes (minutes)" inputMode="numeric" value={f.duration} error={errors.duration_minutes} onChange={set('duration')} optional />
          <Input label="Tagline" value={f.tagline} onChange={set('tagline')} optional maxLength={120} />
          <Input label="Display order" inputMode="numeric" value={f.sort_order} onChange={set('sort_order')} hint="Lower shows first." />
        </div>
        <TextArea label="Description" optional value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={400} />
        <TextArea label="What is included (one per line)" optional value={f.includes} onChange={(e) => setF({ ...f, includes: e.target.value })} rows={5} />
      </form>
    </Sheet>
  );
}

function PriceSheet({ service, onClose }: { service: AdminService | null; onClose: () => void }) {
  const act = useAdminAction();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!service) return;
    const v: Record<string, string> = {};
    for (const p of service.prices) v[p.vehicle_type] = String(p.price_cents / 100);
    setValues(v);
  }, [service]);
  if (!service) return <Sheet open={false} onClose={onClose}><span /></Sheet>;
  const types: VehicleType[] = service.vehicle_type === 'car' ? ['car', 'suv'] : [service.vehicle_type];
  const current = (t: VehicleType) => service.prices.find((p) => p.vehicle_type === t)?.price_cents;

  const save = async (t: VehicleType) => {
    const cents = rupeesToCents(values[t] ?? '');
    if (!cents) return toast.error('Enter a price in rupees.');
    try {
      const r = await act.mutateAsync({ method: 'PUT', path: `services/${service.id}/price`, body: { vehicle_type: t, price_cents: cents } });
      toast.success(r.changed ? `${vehicleLabel[t]} price is now ${rupees(cents)}. New bookings use it from now on.` : 'That is already the price.');
    } catch (err) { toast.error(errText(err)); }
  };

  return (
    <Sheet open onClose={onClose} size="sm" title={`${service.name}: price`} description="The price of one wash. Washes already booked keep the price they were booked at, and the old price stays on record.">
      <div className="space-y-5">
        {types.map((t) => (
          <div key={t} className="space-y-2">
            <Input label={`${vehicleLabel[t]} (₹)`} inputMode="decimal" value={values[t] ?? ''} onChange={(e) => setValues({ ...values, [t]: e.target.value })} hint={current(t) != null ? `Now ${rupees(current(t)!)}` : 'No price set: customers cannot book this yet.'} />
            <Button size="sm" loading={act.isPending} disabled={!rupeesToCents(values[t] ?? '') || rupeesToCents(values[t] ?? '') === current(t)} onClick={() => void save(t)}>Save {vehicleLabel[t]} price</Button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

function Services() {
  const { data, isLoading, isError, refetch } = useAdminServices();
  const act = useAdminAction();
  const toast = useToast();
  const [editing, setEditing] = useState<AdminService | null>(null);
  const [adding, setAdding] = useState(false);
  const [pricing, setPricing] = useState<AdminService | null>(null);
  const [retiring, setRetiring] = useState<AdminService | null>(null);

  const setActive = async (s: AdminService, active: boolean) => {
    try { await act.mutateAsync({ path: `services/${s.id}/active`, body: { active } }); toast.success(active ? 'Service restored' : 'Service retired. Customers no longer see it.'); setRetiring(null); }
    catch (err) { toast.error(errText(err)); setRetiring(null); }
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between"><h2 className="flex items-center gap-2 text-lg font-bold"><Tag className="h-5 w-5 text-washo-300" /> Services and prices</h2><Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add</Button></div>
      {isError ? <ErrorState onRetry={() => void refetch()} /> : isLoading || !data ? <Loading /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((s) => (
            <div key={s.id} className={`glass p-5 ${s.is_active ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-3">
                <div><p className="eyebrow">{s.code}</p><p className="mt-1 text-lg font-bold">{s.name}</p></div>
                <div className="flex flex-wrap justify-end gap-1.5"><Badge tone="blue">{vehicleLabel[s.vehicle_type]}</Badge>{s.used_by_memberships && <Badge tone="green">Memberships</Badge>}{!s.is_active && <Badge>Retired</Badge>}</div>
              </div>
              {s.tagline && <p className="mt-1 text-sm text-fog">{s.tagline}</p>}
              <p className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                {s.prices.length ? s.prices.map((p) => <span key={p.vehicle_type}><span className="font-display text-2xl font-extrabold tabular-nums">{rupees(p.price_cents)}</span><span className="ml-1 text-xs text-fog">{vehicleLabel[p.vehicle_type]}</span></span>) : <span className="text-sm text-warn">No price yet</span>}
              </p>
              <p className="mt-1 text-xs text-fog">{s.duration_minutes ? duration(s.duration_minutes) : 'No duration set'}{s.includes.length ? ` · ${s.includes.length} things included` : ''}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setPricing(s)}>Change price</Button>
                <Button size="sm" variant="glass" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(s)}>Edit</Button>
                {s.is_active
                  ? <Button size="sm" variant="ghost" icon={<Archive className="h-4 w-4" />} disabled={s.used_by_memberships} title={s.used_by_memberships ? 'Memberships are built from this service' : undefined} onClick={() => setRetiring(s)}>Retire</Button>
                  : <Button size="sm" variant="ghost" icon={<ArchiveRestore className="h-4 w-4" />} onClick={() => void setActive(s, true)}>Restore</Button>}
              </div>
            </div>
          ))}
        </div>
      )}
      <ServiceSheet open={adding || Boolean(editing)} service={editing} onClose={() => { setAdding(false); setEditing(null); }} />
      <PriceSheet service={pricing} onClose={() => setPricing(null)} />
      <ConfirmSheet open={Boolean(retiring)} onClose={() => setRetiring(null)} loading={act.isPending} tone="danger" confirmLabel="Retire" title={`Retire ${retiring?.name ?? 'this service'}?`}
        description="Customers will no longer see or book it. Washes already booked, and every past price, stay on record. You can restore it any time." onConfirm={() => retiring && void setActive(retiring, false)} />
    </section>
  );
}

// ───────────────────────── discounts and settings ─────────────────────────
const SETTING_LABELS: Record<string, { label: string; unit: string; percent?: boolean }> = {
  max_total_discount_bp: { label: 'Biggest total membership discount', unit: '%', percent: true },
  weeks_per_month: { label: 'A membership month is billed as', unit: 'weeks' },
  quote_validity_days: { label: 'An old quote can be accepted for', unit: 'days' },
  membership_min_lead_days: { label: 'A membership can start from', unit: 'days from today' },
  on_demand_min_lead_hours: { label: 'A single wash must start at least', unit: 'hours from now' },
  payment_intent_minutes: { label: 'A started payment stays open for', unit: 'minutes' },
};

function Discounts() {
  const { data, isLoading, isError, refetch } = useAdminPricing();
  const act = useAdminAction();
  const toast = useToast();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [nd, setNd] = useState({ kind: 'frequency' as 'frequency' | 'duration', key: '', pct: '', label: '' });
  useEffect(() => {
    if (!data) return;
    setEdits(Object.fromEntries(data.discounts.map((d) => [`${d.kind}:${d.key}`, String(d.discount_bp / 100)])));
    setSettings(Object.fromEntries(data.settings.map((s) => [s.key, String(SETTING_LABELS[s.key]?.percent ? s.value / 100 : s.value)])));
  }, [data]);

  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast.success(ok); } catch (err) { toast.error(errText(err)); } };
  const saveDiscount = (kind: 'frequency' | 'duration', key: number, label: string, pct: string) => {
    const bp = percentToBp(pct);
    if (bp == null) return toast.error('Enter a percentage.');
    return run(() => act.mutateAsync({ method: 'PUT', path: 'discounts', body: { kind, key, discount_bp: bp, label } }), 'Discount saved. New memberships use it from now on.');
  };

  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !data) return <Loading />;
  const group = (kind: 'frequency' | 'duration') => data.discounts.filter((d) => d.kind === kind);

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-bold">Membership discounts</h2>
      <p className="-mt-4 text-sm text-fog">Every discount is shown to the customer as its own line. Together they never go past the cap below. Existing memberships keep the price they paid.</p>
      {(['frequency', 'duration'] as const).map((kind) => (
        <div key={kind} className="space-y-2">
          <h3 className="text-sm font-bold text-mist">{kind === 'frequency' ? 'By washes in a month' : 'By membership length'}</h3>
          {group(kind).map((d) => (
            <div key={`${d.kind}:${d.key}`} className="panel flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1 text-sm"><p className="font-semibold">{d.label}</p><p className="text-xs text-fog">{kind === 'frequency' ? `${d.key === 7 ? '28' : `${4 * d.key} to ${4 * d.key + 3}`} washes a month (${d.key} a week)` : `${d.key} month${d.key > 1 ? 's' : ''}`}</p></div>
              <div className="w-28"><Input label="Percent" aria-label={`${d.label} percent`} inputMode="decimal" value={edits[`${d.kind}:${d.key}`] ?? ''} onChange={(e) => setEdits({ ...edits, [`${d.kind}:${d.key}`]: e.target.value })} /></div>
              <Button size="sm" loading={act.isPending} disabled={percentToBp(edits[`${d.kind}:${d.key}`] ?? '') === d.discount_bp} onClick={() => void saveDiscount(d.kind, d.key, d.label, edits[`${d.kind}:${d.key}`] ?? '')}>Save</Button>
              <Button size="sm" variant="ghost" aria-label={`Remove ${d.label}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => void run(() => act.mutateAsync({ path: 'discounts/remove', body: { kind: d.kind, key: d.key } }), 'Discount removed')} />
            </div>
          ))}
          {!group(kind).length && <p className="panel p-3 text-center text-sm text-fog">None.</p>}
        </div>
      ))}
      <Button size="sm" variant="glass" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add a discount</Button>

      <div className="space-y-3 border-t border-white/10 pt-6">
        <h2 className="text-lg font-bold">Pricing rules</h2>
        {data.settings.map((s) => {
          const meta = SETTING_LABELS[s.key] ?? { label: s.key, unit: '' };
          const raw = settings[s.key] ?? '';
          const value = meta.percent ? percentToBp(raw) : raw.trim() === '' ? null : Math.round(Number(raw));
          return (
            <div key={s.key} className="panel flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1 text-sm"><p className="font-semibold">{meta.label}</p><p className="text-xs text-fog">{s.description}</p></div>
              <div className="w-28"><Input label={meta.unit || 'Value'} aria-label={meta.label} inputMode="decimal" value={raw} onChange={(e) => setSettings({ ...settings, [s.key]: e.target.value })} /></div>
              <Button size="sm" loading={act.isPending} disabled={value == null || Number.isNaN(value) || value === s.value} onClick={() => void run(() => act.mutateAsync({ method: 'PUT', path: 'pricing-settings', body: { key: s.key, value } }), 'Saved')}>Save</Button>
            </div>
          );
        })}
      </div>

      <Sheet open={adding} onClose={() => setAdding(false)} size="sm" title="Add a discount" description="Adding one for a number that already has a discount replaces it (the old one stays on record)."
        footer={<Button full size="lg" loading={act.isPending} disabled={!nd.key || percentToBp(nd.pct) == null || nd.label.trim().length < 2}
          onClick={async () => { await saveDiscount(nd.kind, Number(nd.key), nd.label.trim(), nd.pct); setAdding(false); setNd({ kind: 'frequency', key: '', pct: '', label: '' }); }}>Save discount</Button>}>
        <div className="space-y-4">
          <Select label="Applies to" value={nd.kind} onChange={(e) => setNd({ ...nd, kind: e.target.value as 'frequency' | 'duration' })}>
            <option value="frequency">Washes in a month</option>
            <option value="duration">Membership length</option>
          </Select>
          <Input label={nd.kind === 'frequency' ? 'Washes a week equivalent (1 to 7: 4 a month = 1, 8 = 2, 12 = 3 ... 28 = 7)' : 'Months (1, 3, 6 or 12)'} inputMode="numeric" value={nd.key} onChange={(e) => setNd({ ...nd, key: e.target.value.replace(/\D/g, '') })} />
          <Input label="Percent off" inputMode="decimal" value={nd.pct} onChange={(e) => setNd({ ...nd, pct: e.target.value })} hint="Up to 50." />
          <Input label="Label the customer sees" value={nd.label} onChange={(e) => setNd({ ...nd, label: e.target.value })} maxLength={60} />
        </div>
      </Sheet>
    </section>
  );
}

export default function ServicesAdmin() {
  return (
    <div className="space-y-12">
      <Services />
      <Discounts />
    </div>
  );
}
