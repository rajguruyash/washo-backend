import { Plus, Tag, Trash2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { fullDate, istDay, percent, relativeTime, rupees, todayIST } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useAdminAction, useAdminCouponUses, useAdminCoupons, useAdminPricing } from '../../lib/queries';
import type { AdminCoupon, CouponKind } from '../../lib/types';
import { Loading, Switch, errText, percentToBp } from './shared';

const CAP_KEY = 'max_total_discount_bp';

// ───────────────────────── the two automatic discounts, and their cap ─────────────────────────
function Rules({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, isError, refetch } = useAdminPricing();
  const act = useAdminAction();
  const toast = useToast();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [cap, setCap] = useState('');
  const [adding, setAdding] = useState(false);
  const [nd, setNd] = useState({ kind: 'frequency' as 'frequency' | 'duration', key: '', pct: '', label: '' });
  useEffect(() => {
    if (!data) return;
    setEdits(Object.fromEntries(data.discounts.map((d) => [`${d.kind}:${d.key}`, String(d.discount_bp / 100)])));
    setCap(String((data.settings.find((s) => s.key === CAP_KEY)?.value ?? 0) / 100));
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
  const capNow = data.settings.find((s) => s.key === CAP_KEY);
  const capBp = percentToBp(cap);

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-bold">Automatic discounts</h2>
        <p className="mt-1 max-w-2xl text-sm text-fog">Every membership gets these by itself and the customer sees each as its own line: one for how many washes a month, one for how long the membership is. The first comes off the plan price, then the second off what is left. Together they never go past the biggest total below. A coupon (further down) comes on top. Memberships already paid for keep the price they paid.</p>
      </div>
      {(['frequency', 'duration'] as const).map((kind) => (
        <div key={kind} className="space-y-2">
          <h3 className="text-sm font-bold text-mist">{kind === 'frequency' ? 'By washes in a month' : 'By membership length'}</h3>
          {group(kind).map((d) => (
            <div key={`${d.kind}:${d.key}`} className="panel flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1 text-sm"><p className="font-semibold">{d.label}</p><p className="text-xs text-fog">{kind === 'frequency' ? `${d.key === 7 ? '28' : `${4 * d.key} to ${4 * d.key + 3}`} washes a month` : `${d.key} month${d.key > 1 ? 's' : ''}`}</p></div>
              <div className="w-28"><Input label="Percent" aria-label={`${d.label} percent`} inputMode="decimal" disabled={!canEdit} value={edits[`${d.kind}:${d.key}`] ?? ''} onChange={(e) => setEdits({ ...edits, [`${d.kind}:${d.key}`]: e.target.value })} /></div>
              {canEdit && (
                <>
                  <Button size="sm" loading={act.isPending} disabled={percentToBp(edits[`${d.kind}:${d.key}`] ?? '') === d.discount_bp} onClick={() => void saveDiscount(d.kind, d.key, d.label, edits[`${d.kind}:${d.key}`] ?? '')}>Save</Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${d.label}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => void run(() => act.mutateAsync({ path: 'discounts/remove', body: { kind: d.kind, key: d.key } }), 'Discount removed')} />
                </>
              )}
            </div>
          ))}
          {!group(kind).length && <p className="panel p-3 text-center text-sm text-fog">None.</p>}
        </div>
      ))}
      {canEdit && <Button size="sm" variant="glass" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add a discount</Button>}

      {capNow && (
        <div className="space-y-2">
          <h3 className="text-sm font-bold text-mist">Biggest total of the two</h3>
          <div className="panel flex flex-wrap items-center gap-3 p-3">
            <div className="min-w-0 flex-1 text-sm"><p className="font-semibold">Never more than {percent(capNow.value)} off from these two together</p><p className="text-xs text-fog">Coupons are not counted in this.</p></div>
            <div className="w-28"><Input label="Percent" aria-label="Biggest total discount percent" inputMode="decimal" disabled={!canEdit} value={cap} onChange={(e) => setCap(e.target.value)} /></div>
            {canEdit && <Button size="sm" loading={act.isPending} disabled={capBp == null || capBp === capNow.value} onClick={() => void run(() => act.mutateAsync({ method: 'PUT', path: 'pricing-settings', body: { key: CAP_KEY, value: capBp } }), 'Saved')}>Save</Button>}
          </div>
        </div>
      )}

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

// ───────────────────────── coupons ─────────────────────────
const STATUS: Record<AdminCoupon['status'], { text: string; tone: 'green' | 'slate' | 'amber' | 'red' }> = {
  live: { text: 'Live', tone: 'green' },
  off: { text: 'Off', tone: 'slate' },
  expired: { text: 'Expired', tone: 'amber' },
  used_up: { text: 'Used up', tone: 'amber' },
};

const WORKS_ON: Record<CouponKind, string> = { both: 'Memberships and single washes', membership: 'Memberships only', single: 'Single washes only' };

interface CouponForm { code: string; pct: string; label: string; expires: string; max: string; once: boolean; applies: CouponKind }
const blank: CouponForm = { code: '', pct: '5', label: '', expires: '', max: '', once: true, applies: 'both' };

function CouponSheet({ open, coupon, onClose }: { open: boolean; coupon: AdminCoupon | null; onClose: () => void }) {
  const act = useAdminAction();
  const toast = useToast();
  const [f, setF] = useState<CouponForm>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    setErrors({});
    setF(coupon ? { code: coupon.code, pct: String(coupon.discount_bp / 100), label: coupon.label ?? '', expires: coupon.expires_on ?? '', max: coupon.max_uses ? String(coupon.max_uses) : '', once: coupon.once_per_customer, applies: coupon.applies_to } : blank);
  }, [coupon, open]);

  const bp = percentToBp(f.pct);
  const pctOk = bp != null && bp >= 1 && bp <= 5000;
  const codeOk = coupon ? true : /^[A-Za-z0-9]{3,20}$/.test(f.code.trim());
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    const body = { code: coupon ? undefined : f.code.trim(), discount_bp: bp, label: f.label.trim() || null, expires_on: f.expires || null, max_uses: f.max.trim() ? Number(f.max) : null, once_per_customer: f.once, applies_to: f.applies };
    try {
      await act.mutateAsync(coupon ? { method: 'PUT', path: `coupons/${coupon.id}`, body } : { path: 'coupons', body });
      toast.success(coupon ? 'Coupon saved' : `Coupon ${f.code.trim().toUpperCase()} is live. Tell people to type it on the last step.`);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setErrors({ _: errText(err) });
    }
  };

  return (
    <Sheet open={open} onClose={onClose} size="sm" title={coupon ? `Change ${coupon.code}` : 'Make a coupon'} description={coupon ? 'The code itself cannot change: make a new coupon for a new code.' : 'People type the code on the last step and get that percentage off the price. On a membership it comes on top of the other discounts.'}
      footer={<Button full size="lg" loading={act.isPending} disabled={!pctOk || !codeOk} onClick={(e) => void submit(e as unknown as React.FormEvent)}>{coupon ? 'Save' : 'Make the coupon'}</Button>}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        <Input label="Code" value={f.code} disabled={Boolean(coupon)} maxLength={20} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="For example EXTRA5"
          onChange={(e) => setF({ ...f, code: e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase() })} error={errors.code} hint={coupon ? undefined : '3 to 20 letters and numbers. Capitals do not matter when people type it.'} />
        <Select label="Works on" value={f.applies} onChange={(e) => setF({ ...f, applies: e.target.value as CouponKind })} error={errors.applies_to} hint="Where a customer can type it: on a membership, on a single wash, or on both.">
          {(Object.keys(WORKS_ON) as CouponKind[]).map((k) => <option key={k} value={k}>{WORKS_ON[k]}</option>)}
        </Select>
        <Input label="Percent off the price" inputMode="decimal" value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} error={errors.discount_bp ?? (f.pct && !pctOk ? 'Between 0.01 and 50' : undefined)}
          hint={pctOk ? `For a ₹1,000 plan that is ${rupees(Math.round(1000_00 * (bp as number) / 10000))} off, extra.` : undefined} />
        <Input label="Note for yourself" optional value={f.label} maxLength={60} onChange={(e) => setF({ ...f, label: e.target.value })} error={errors.label} placeholder="For example Word of mouth, Navratri" />
        <Input label="Last day" optional type="date" min={todayIST()} value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} error={errors.expires_on} hint="Leave empty for no end date." />
        <Input label="Most times it can be used" optional inputMode="numeric" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value.replace(/\D/g, '') })} error={errors.max_uses} hint="Counts memberships that were paid for. Leave empty for no limit." />
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <div className="text-sm"><p className="font-semibold">Each customer can use it once</p><p className="text-xs text-fog">Switch off to let the same customer use it on every membership.</p></div>
          <Switch on={f.once} onChange={(v) => setF({ ...f, once: v })} label="Each customer can use it once" />
        </div>
        {errors._ && <p role="alert" className="text-sm text-bad">{errors._}</p>}
      </form>
    </Sheet>
  );
}

function UsesSheet({ coupon, onClose }: { coupon: AdminCoupon | null; onClose: () => void }) {
  const { data, isLoading, isError } = useAdminCouponUses(coupon?.id ?? null);
  return (
    <Sheet open={Boolean(coupon)} onClose={onClose} size="md" title={coupon ? `Who used ${coupon.code}` : ''} description={coupon ? `${coupon.uses} purchase${coupon.uses === 1 ? '' : 's'} paid for with it, ${rupees(coupon.saved_cents)} off in all. The latest 50 are shown.` : undefined}
      footer={<Button full variant="glass" onClick={onClose}>Close</Button>}>
      {isError ? <p className="text-sm text-bad">Could not load this.</p> : isLoading ? <Loading /> : !data?.length ? <p className="text-sm text-fog">Nobody has paid with this coupon yet.</p> : (
        <ul className="divide-y divide-white/5 rounded-2xl border border-white/10 bg-white/[0.03]">
          {data.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <div className="min-w-0"><p className="truncate font-semibold">{u.customer_name ?? 'Customer'}</p><p className="truncate text-xs text-fog">{u.kind === 'single' ? 'Single wash' : 'Membership'} · {u.reference_code ?? ''} · paid {rupees(u.plan_cents)}</p></div>
              <div className="text-right"><p className="font-semibold text-ok">−{rupees(u.discount_cents)}</p><p className="text-xs text-fog">{relativeTime(u.at)}</p></div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

function Coupons({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, isError, refetch } = useAdminCoupons();
  const act = useAdminAction();
  const toast = useToast();
  const [editing, setEditing] = useState<AdminCoupon | null>(null);
  const [making, setMaking] = useState(false);
  const [uses, setUses] = useState<AdminCoupon | null>(null);
  const toggle = async (c: AdminCoupon) => {
    try { await act.mutateAsync({ path: `coupons/${c.id}/active`, body: { active: !c.is_active } }); toast.success(c.is_active ? `${c.code} is off. Nobody can start using it.` : `${c.code} is on`); } catch (e) { toast.error(errText(e)); }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold"><Tag className="h-5 w-5 text-washo-300" /> Coupons</h2>
          <p className="mt-1 max-w-2xl text-sm text-fog">Make a code (for example EXTRA5 worth 5%), choose whether it works on memberships, single washes or both, tell people, and they type it on the last step to get that much off. It shows as its own line (on a membership it comes on top of the automatic discounts). Nothing is ever deleted: switch a coupon off and every use stays on record.</p>
        </div>
        {canEdit && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setMaking(true)}>Make a coupon</Button>}
      </div>
      {isError ? <ErrorState onRetry={() => void refetch()} /> : isLoading || !data ? <Loading /> : !data.length ? (
        <p className="panel p-6 text-center text-sm text-fog">No coupons yet.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.map((c) => (
            <div key={c.id} className={`glass p-5 ${c.status === 'live' ? '' : 'opacity-75'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-xl font-bold tracking-wide">{c.code}</p>
                  {c.label && <p className="truncate text-sm text-fog">{c.label}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2"><span className="font-display text-2xl font-extrabold tabular-nums">{percent(c.discount_bp)}</span><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].text}</Badge></div>
              </div>
              <div className="mt-2"><Badge tone="blue">{WORKS_ON[c.applies_to]}</Badge>
              </div>
              <p className="mt-3 text-sm text-mist">
                Used <strong className="text-white">{c.uses}</strong> time{c.uses === 1 ? '' : 's'}{c.max_uses ? ` of ${c.max_uses}` : ''} · {rupees(c.saved_cents)} off in all{c.last_used_at ? ` · last ${relativeTime(c.last_used_at)}` : ''}
              </p>
              <p className="mt-1 text-xs text-fog">{c.expires_on ? `Until ${fullDate(c.expires_on)}` : 'No end date'} · {c.once_per_customer ? 'once per customer' : 'a customer can use it again'} · made {fullDate(istDay(c.created_at))}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="glass" icon={<Users className="h-4 w-4" />} onClick={() => setUses(c)}>Who used it</Button>
                {canEdit && <Button size="sm" variant="glass" onClick={() => setEditing(c)}>Change</Button>}
                {canEdit && <Button size="sm" variant={c.is_active ? 'ghost' : 'primary'} loading={act.isPending} onClick={() => void toggle(c)}>{c.is_active ? 'Switch off' : 'Switch on'}</Button>}
              </div>
            </div>
          ))}
        </div>
      )}
      <CouponSheet open={making || Boolean(editing)} coupon={editing} onClose={() => { setMaking(false); setEditing(null); }} />
      <UsesSheet coupon={uses} onClose={() => setUses(null)} />
    </section>
  );
}

/** Everything that takes money off a membership: the two automatic discounts and their cap (Services area), and coupons (Campaigns area). Each part shows only to a role that may see it. */
export default function Discounts({ rules, editRules, coupons, editCoupons }: { rules: boolean; editRules: boolean; coupons: boolean; editCoupons: boolean }) {
  return (
    <div className="space-y-12">
      {rules && <Rules canEdit={editRules} />}
      {coupons && <Coupons canEdit={editCoupons} />}
    </div>
  );
}
