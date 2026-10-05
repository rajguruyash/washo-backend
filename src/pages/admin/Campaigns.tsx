import { ArrowLeft, Gift, Pencil, Plus, Power } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { Badge, type Tone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select, TextArea } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { dayOf, shortDayIST } from '../../lib/campaign';
import { addDays, percent, prettyDate, prettyPhone, rupees, todayIST, vehicleLabel } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useAdminAction, useAdminCampaign, useAdminCampaignClaims, useAdminCampaigns } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { staffStatus } from '../../lib/status';
import type { AdminCampaign, AdminCampaignClaim } from '../../lib/types';
import { BookingSheet } from './BookingSheet';
import { Loading, errText } from './shared';

/** Where a campaign is right now, in words, for its badge. */
function liveState(c: AdminCampaign): { label: string; tone: Tone } {
  const today = todayIST();
  if (!c.is_active) return { label: 'Switched off', tone: 'slate' };
  if (today < c.claim_opens_on) return { label: `Opens ${dayOf(c.claim_opens_on)}`, tone: 'blue' };
  if (today > c.claim_closes_on) return { label: 'Claims closed', tone: 'slate' };
  if (c.claimed >= c.total_cap) return { label: 'All claimed', tone: 'amber' };
  return { label: 'Live', tone: 'green' };
}

const claimTone: Record<AdminCampaignClaim['status'], { label: string; tone: Tone }> = {
  booked: { label: 'Booked', tone: 'blue' },
  completed: { label: 'Done', tone: 'green' },
  forfeited: { label: 'Missed', tone: 'red' },
  released: { label: 'Given back', tone: 'slate' },
};

const Stat = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
  <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
    <p className="font-display text-2xl font-extrabold tabular-nums">{value}</p>
    <p className="text-xs text-fog">{label}</p>
    {sub && <p className="mt-0.5 text-[11px] text-mist">{sub}</p>}
  </div>
);

const bpOf = (percentText: string) => Math.round(Number(percentText) * 100);

// ───────────────────────── create / edit ─────────────────────────
function CampaignSheet({ open, campaign, onClose }: { open: boolean; campaign: AdminCampaign | null; onClose: () => void }) {
  const act = useAdminAction();
  const toast = useToast();
  const blank = () => {
    const today = todayIST();
    return { code: 'navratri-2026', name: 'Navratri free wash', description: 'A free body wash at your parking spot for new WASHO customers.', opens: today, closes: addDays(today, 1), useBy: addDays(today, 6), total: '100', daily: '', offerDays: '14', p1: '5', p2: '10', p3: '15', on: false };
  };
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    setErrors({});
    setF(campaign
      ? { code: campaign.code, name: campaign.name, description: campaign.description ?? '', opens: campaign.claim_opens_on, closes: campaign.claim_closes_on, useBy: campaign.use_by_date, total: String(campaign.total_cap), daily: campaign.daily_cap ? String(campaign.daily_cap) : '', offerDays: String(campaign.pack_offer_days), p1: String(campaign.pack_bp_1 / 100), p2: String(campaign.pack_bp_2 / 100), p3: String(campaign.pack_bp_3plus / 100), on: campaign.is_active }
      : blank());
  }, [campaign, open]);
  const set = (k: keyof ReturnType<typeof blank>) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    const body = {
      ...(campaign ? {} : { code: f.code, active: f.on }),
      name: f.name, description: f.description || undefined,
      claim_opens_on: f.opens, claim_closes_on: f.closes, use_by_date: f.useBy,
      total_cap: Number(f.total), daily_cap: f.daily.trim() ? Number(f.daily) : null,
      pack_offer_days: Number(f.offerDays), pack_bp_1: bpOf(f.p1), pack_bp_2: bpOf(f.p2), pack_bp_3plus: bpOf(f.p3),
    };
    try {
      await act.mutateAsync(campaign ? { method: 'PUT', path: `campaigns/${campaign.id}`, body } : { path: 'campaigns', body });
      toast.success(campaign ? 'Campaign saved' : f.on ? 'Campaign created and switched on' : 'Campaign created. Switch it on when you are ready.');
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields); else toast.error(errText(err));
    }
  };

  return (
    <Sheet open={open} onClose={onClose} size="lg" title={campaign ? `Edit ${campaign.name}` : 'New campaign'} description={campaign ? undefined : 'A free body wash for new customers. It stays hidden from the website until you switch it on.'}
      footer={<Button type="submit" form="campaign-form" full size="lg" loading={act.isPending}>{campaign ? 'Save campaign' : 'Create campaign'}</Button>}>
      <form id="campaign-form" onSubmit={submit} className="space-y-6" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Name" value={f.name} error={errors.name} onChange={set('name')} required />
          {campaign ? <Input label="Short name" value={f.code} disabled hint="Fixed once created." /> : <Input label="Short name" value={f.code} error={errors.code} onChange={set('code')} hint="Lowercase and dashes, like navratri-2026." required />}
        </div>
        <TextArea label="What the page says" optional value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={400} rows={2} />

        <fieldset className="space-y-3">
          <legend className="text-sm font-bold">When</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Input label="Claims open" type="date" value={f.opens} error={errors.claim_opens_on} onChange={set('opens')} />
            <Input label="Claims close" type="date" value={f.closes} min={f.opens} error={errors.claim_closes_on} onChange={set('closes')} />
            <Input label="Last day for the wash" type="date" value={f.useBy} min={f.opens} error={errors.use_by_date} onChange={set('useBy')} />
          </div>
          <p className="text-xs text-fog">Both days count in full. A customer can claim until the end of the last claim day, for a wash on or before the last day for the wash.</p>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-bold">How many</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Free washes in total" inputMode="numeric" value={f.total} error={errors.total_cap} onChange={set('total')} hint="Your budget: the offer closes by itself when they are gone." />
            <Input label="Most washes on one day" inputMode="numeric" optional value={f.daily} error={errors.daily_cap} onChange={set('daily')} hint="Keeps free washes from crowding out paying customers. Empty means no limit." />
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-bold">Membership offer after the free wash</legend>
          <div className="grid gap-4 sm:grid-cols-4">
            <Input label="1 wash per week (%)" inputMode="decimal" value={f.p1} error={errors.pack_bp_1} onChange={set('p1')} />
            <Input label="2 per week (%)" inputMode="decimal" value={f.p2} error={errors.pack_bp_2} onChange={set('p2')} />
            <Input label="3 or more (%)" inputMode="decimal" value={f.p3} error={errors.pack_bp_3plus} onChange={set('p3')} />
            <Input label="Open for (days)" inputMode="numeric" value={f.offerDays} error={errors.pack_offer_days} onChange={set('offerDays')} />
          </div>
          <p className="text-xs text-fog">Starts when their free wash is done. It replaces the normal frequency discount, never lowers it, and is applied for them at checkout.</p>
        </fieldset>

        {!campaign && (
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-mist">Show it on the website now?</p>
            <Segmented label="Switch on now" value={f.on ? 'on' : 'off'} onChange={(v) => setF({ ...f, on: v === 'on' })} options={[{ value: 'off', label: 'Not yet' }, { value: 'on', label: 'Yes, switch on' }]} />
          </div>
        )}
      </form>
    </Sheet>
  );
}

// ───────────────────────── one campaign ─────────────────────────
function ClaimRow({ c, onOpen }: { c: AdminCampaignClaim; onOpen: () => void }) {
  const s = claimTone[c.status];
  const offer =
    c.offer_membership_id ? `Bought a membership${c.pack_cents != null ? ` · ${rupees(c.pack_cents)}` : ''}`
    : c.status === 'completed' && c.offer_expires_at ? (new Date(c.offer_expires_at) > new Date() ? `Offer open until ${shortDayIST(c.offer_expires_at)}` : 'Offer ended') : null;
  return (
    <li>
      <button onClick={onOpen} className="panel flex w-full flex-wrap items-center gap-x-4 gap-y-2 p-4 text-left transition-colors hover:border-washo-400/40">
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate font-semibold">{c.customer_name ?? 'No name'}</p>
          <p className="text-xs text-fog">{prettyPhone(c.customer_phone)}</p>
        </div>
        <div className="min-w-0 flex-1 basis-40 text-sm">
          <p className="truncate">{vehicleLabel[c.vehicle_type]} · {c.vehicle_model}</p>
          <p className="text-xs text-fog">{c.registration_number}</p>
        </div>
        <div className="basis-40 text-sm">
          <p>{prettyDate(c.scheduled_date)}</p>
          <p className="text-xs text-fog">{slotLabel(c.time_slot)} · {staffStatus[c.booking_status].label}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge tone={s.tone}>{s.label}</Badge>
          {offer && <span className="text-[11px] text-mist">{offer}</span>}
        </div>
      </button>
    </li>
  );
}

function CampaignDetail({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit: (c: AdminCampaign) => void }) {
  const { data, isLoading, isError, error, refetch } = useAdminCampaign(id);
  const act = useAdminAction();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const claims = useAdminCampaignClaims(id, status, debounced);
  const [open, setOpen] = useState<string | null>(null);

  if (isError) return <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />;
  if (isLoading || !data) return <Loading />;
  const { campaign: c, days } = data;
  const st = liveState(c);
  const toggle = async () => {
    try { await act.mutateAsync({ path: `campaigns/${c.id}/active`, body: { active: !c.is_active } }); toast.success(c.is_active ? 'Switched off. It is no longer on the website.' : 'Switched on. It is on the website.'); } catch (e) { toast.error(errText(e)); }
  };
  const peak = Math.max(c.daily_cap ?? 0, ...days.map((d) => d.washes), 1);

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-semibold text-washo-300 hover:text-white"><ArrowLeft className="h-4 w-4" /> All campaigns</button>
      <div className="glass p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-2xl font-extrabold">{c.name}</h2><Badge tone={st.tone}>{st.label}</Badge></div>
            <p className="mt-1 text-sm text-fog">Claims {dayOf(c.claim_opens_on)} to {dayOf(c.claim_closes_on)} · wash by {dayOf(c.use_by_date)} · page: /navratri</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="glass" icon={<Pencil className="h-4 w-4" />} onClick={() => onEdit(c)}>Edit</Button>
            <Button size="sm" variant={c.is_active ? 'danger' : 'primary'} icon={<Power className="h-4 w-4" />} loading={act.isPending} onClick={() => void toggle()}>{c.is_active ? 'Switch off' : 'Switch on'}</Button>
          </div>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-offer to-washo-300" style={{ width: `${Math.min(100, (c.claimed / c.total_cap) * 100)}%` }} /></div>
        <p className="mt-2 text-xs text-fog">{c.claimed} of {c.total_cap} free washes claimed · {Math.max(c.total_cap - c.claimed, 0)} left</p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Stat label="Booked" value={c.booked} />
          <Stat label="Done" value={c.completed} />
          <Stat label="Missed" value={c.forfeited} />
          <Stat label="Given back" value={c.released} sub="cancelled" />
          <Stat label="Offers open" value={c.offers_open} sub="free wash done" />
          <Stat label="Memberships bought" value={c.packs_bought} />
          <Stat label="Membership sales" value={rupees(Number(c.packs_cents))} />
        </div>
        <p className="mt-3 text-xs text-fog">Membership offer: {percent(c.pack_bp_1)} for 1 per week, {percent(c.pack_bp_2)} for 2, {percent(c.pack_bp_3plus)} for 3 or more, for {c.pack_offer_days} days after the free wash.</p>
      </div>

      <section>
        <h3 className="mb-2 text-lg font-bold">Washes per day</h3>
        {days.length ? (
          <ul className="panel divide-y divide-white/[0.07]">
            {days.map((d) => {
              const full = c.daily_cap != null && d.washes >= c.daily_cap;
              return (
                <li key={d.date} className="flex items-center gap-4 px-4 py-2.5 text-sm">
                  <span className="w-32 shrink-0 font-semibold">{dayOf(d.date)}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/10"><span className={`block h-full rounded-full ${full ? 'bg-warn' : 'bg-washo-400'}`} style={{ width: `${(d.washes / peak) * 100}%` }} /></span>
                  <span className="w-24 shrink-0 text-right tabular-nums text-mist">{d.washes}{c.daily_cap != null ? ` of ${c.daily_cap}` : ''}{full ? ' · full' : ''}</span>
                </li>
              );
            })}
          </ul>
        ) : <p className="panel p-5 text-sm text-fog">No claims yet.</p>}
        <p className="mt-2 text-xs text-fog">{c.daily_cap != null ? `A day closes to new claims at ${c.daily_cap} free washes.` : 'No daily limit is set. Add one with Edit to protect paid slots.'}</p>
      </section>

      <section>
        <h3 className="mb-2 text-lg font-bold">Claims</h3>
        <div className="mb-3 grid gap-3 sm:grid-cols-[12rem_1fr]">
          <Select label="Show" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="booked">Booked</option>
            <option value="completed">Done</option>
            <option value="forfeited">Missed</option>
            <option value="released">Given back</option>
          </Select>
          <Input label="Search" placeholder="Name, phone, plate or reference" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {claims.isError ? <ErrorState onRetry={() => void claims.refetch()} /> : claims.isLoading ? <Loading /> : claims.data?.length ? (
          <ul className="space-y-2">{claims.data.map((cl) => <ClaimRow key={cl.id} c={cl} onOpen={() => setOpen(cl.booking_id)} />)}</ul>
        ) : <p className="panel p-6 text-center text-sm text-fog">No claims match.</p>}
      </section>
      <BookingSheet id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

// ───────────────────────── all campaigns ─────────────────────────
export default function Campaigns() {
  const { data, isLoading, isError, error, refetch } = useAdminCampaigns();
  const act = useAdminAction();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminCampaign | 'new' | null>(null);
  const sheet = useMemo(() => (editing === 'new' ? null : editing), [editing]);

  const sheetEl = <CampaignSheet open={Boolean(editing)} campaign={sheet} onClose={() => setEditing(null)} />;
  if (open) return <><CampaignDetail id={open} onBack={() => setOpen(null)} onEdit={setEditing} />{sheetEl}</>;
  if (isError) return <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />;
  if (isLoading || !data) return <Loading />;

  const toggle = async (c: AdminCampaign) => {
    try { await act.mutateAsync({ path: `campaigns/${c.id}/active`, body: { active: !c.is_active } }); toast.success(c.is_active ? 'Switched off' : 'Switched on. It is on the website now.'); } catch (e) { toast.error(errText(e)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-fog">Free-wash offers for new customers, like the Navratri campaign. Create one, switch it on, and watch the claims here.</p>
        <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>New campaign</Button>
      </div>
      {!data.length && (
        <div className="panel p-8 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-offer/15 text-offer"><Gift className="h-6 w-6" /></span>
          <p className="mt-3 font-semibold">No campaigns yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-fog">Set the dates, how many free washes there are and the membership offer. It stays off the website until you switch it on.</p>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.map((c) => {
          const st = liveState(c);
          return (
            <div key={c.id} className="glass p-5">
              <div className="flex items-start justify-between gap-3">
                <button onClick={() => setOpen(c.id)} className="min-w-0 text-left">
                  <p className="truncate text-lg font-bold hover:text-washo-300">{c.name}</p>
                  <p className="text-xs text-fog">{c.code} · claims {dayOf(c.claim_opens_on)} to {dayOf(c.claim_closes_on)}</p>
                </button>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-offer to-washo-300" style={{ width: `${Math.min(100, (c.claimed / c.total_cap) * 100)}%` }} /></div>
              <p className="mt-2 text-xs text-fog">{c.claimed} of {c.total_cap} claimed · {c.completed} done · {c.packs_bought} memberships bought</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="glass" onClick={() => setOpen(c.id)}>Claims and numbers</Button>
                <Button size="sm" variant="glass" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(c)}>Edit</Button>
                <Button size="sm" variant={c.is_active ? 'danger' : 'primary'} icon={<Power className="h-4 w-4" />} loading={act.isPending} onClick={() => void toggle(c)}>{c.is_active ? 'Switch off' : 'Switch on'}</Button>
              </div>
            </div>
          );
        })}
      </div>
      {sheetEl}
    </div>
  );
}
