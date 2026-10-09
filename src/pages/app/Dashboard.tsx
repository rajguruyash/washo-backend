import { ArrowRight, BadgeCheck, CalendarDays, Camera, Car, Clock, Gift, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Plate } from '../../components/brand/Plate';
import { CampaignGlare } from '../../components/CampaignGlare';
import { PackOfferCard } from '../../components/PackOfferCard';
import { RenewalNotice } from '../../components/RenewalNotice';
import { RemovePlan } from '../../components/RemovePlan';
import { EmptyState, PageHeader } from '../../components/EmptyState';
import { BookingCard } from '../../components/WashBits';
import { Badge } from '../../components/ui/Badge';
import { ButtonLink } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Skeleton';
import { audience, claimView, dayOf } from '../../lib/campaign';
import { prettyDate } from '../../lib/format';
import { useBookings, useCampaign, useMemberships, useRequests } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { useAuth } from '../../state/auth';
import { planTitle } from '../../lib/plan';

export default function Dashboard() {
  const { user } = useAuth();
  const memberships = useMemberships();
  const requests = useRequests();
  const upcoming = useBookings('upcoming', true);
  const past = useBookings('past', Boolean(upcoming.data?.length));
  const first = user?.full_name?.split(' ')[0];
  const open = requests.data?.filter((r) => ['submitted', 'quoted', 'accepted'].includes(r.status)) ?? [];
  const active = memberships.data?.filter((m) => m.status === 'active') ?? [];
  const completed = past.data?.filter((b) => b.status === 'completed').slice(0, 3) ?? [];
  const loading = memberships.isLoading || requests.isLoading;
  const campaign = useCampaign().data;
  const view = claimView(campaign, user?.role);
  const c = campaign?.campaign;
  const me = campaign?.me;

  return (
    <>
      <PageHeader title={first ? `Hi, ${first}` : 'Welcome'} subtitle="Your washes, memberships and requests in one place." action={<ButtonLink to="/app/membership/new" icon={<Plus className="h-4 w-4" />}>Start a membership</ButtonLink>} />

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
      ) : (
        <div className="space-y-8">
          <RenewalNotice />
          {view === 'eligible' && c && (
            <CampaignGlare><Link to="/app/claim" className="glass flex items-center gap-4 border-offer/30 p-5 transition-colors hover:border-offer/60">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-offer/15 text-offer"><Gift className="h-6 w-6" /></span>
              <div className="min-w-0 flex-1">
                <p className="font-bold">{c.name}: claim your free wash</p>
                <p className="text-sm text-fog">A free body wash {audience(c).short}. Claim by {dayOf(c.claim_closes_on)}{c.spots_left <= 30 ? ` · only ${c.spots_left} left` : ''}.</p>
              </div>
              <ArrowRight className="h-5 w-5 text-fog" />
            </Link></CampaignGlare>
          )}
          {view === 'booked' && me && 'booking_id' in me && (
            <CampaignGlare><Link to={`/app/bookings/${me.booking_id}`} className="glass flex items-center gap-4 border-offer/30 p-5 transition-colors hover:border-offer/60">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-offer/15 text-offer"><Gift className="h-6 w-6" /></span>
              <div className="min-w-0 flex-1">
                <p className="font-bold">Your free wash is booked</p>
                <p className="text-sm text-fog">{me.scheduled_date ? `${prettyDate(me.scheduled_date)}${me.time_slot ? `, ${slotLabel(me.time_slot)}` : ''}` : 'See the details'}</p>
              </div>
              <ArrowRight className="h-5 w-5 text-fog" />
            </Link></CampaignGlare>
          )}
          {campaign?.offer && <PackOfferCard offer={campaign.offer} />}
          {open.map((r) => (
            <div key={r.id} className="glass border-washo-400/30 p-5 transition-colors hover:border-washo-400/60">
              <Link to={`/app/membership/requests/${r.id}`} className="flex items-center gap-4">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-washo-500/15 text-washo-300"><Clock className="h-6 w-6" /></span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{r.status === 'quoted' ? 'Your price is ready' : r.status === 'accepted' ? 'Finish your payment' : 'WASHO is reviewing your request'}</p>
                  <p className="text-sm text-fog">{planTitle(r)} · {r.vehicle_model}</p>
                </div>
                <ArrowRight className="h-5 w-5 text-fog" />
              </Link>
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-4">
                <p className="text-xs text-fog">Changed your mind? Nothing has been charged.</p>
                <RemovePlan kind="request" id={r.id} unpaid />
              </div>
            </div>
          ))}

          {(active.length > 0 || !open.length) && <section aria-labelledby="mem">
            <h2 id="mem" className="mb-3 text-lg font-bold">Memberships</h2>
            {active.length ? (
              <div className="grid gap-4 md:grid-cols-2">
                {active.map((m) => (
                  <div key={m.id} className="glass p-5 transition-colors hover:border-washo-400/40">
                  <Link to={`/app/membership/${m.id}`} className="block">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="eyebrow">{m.reference_code}</p>
                        <p className="mt-1 text-lg font-bold">{planTitle(m, { short: true })}</p>
                      </div>
                      <Badge tone="green" icon={<BadgeCheck className="h-3.5 w-3.5" />}>Active</Badge>
                    </div>
                    {m.registration_number && <Plate reg={m.registration_number} className="mt-3" />}
                    <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-washo-500 to-washo-300" style={{ width: `${m.washes_total ? (m.washes_completed / m.washes_total) * 100 : 0}%` }} /></div>
                    <p className="mt-2 text-xs text-fog">{m.washes_completed} of {m.washes_total} washes done{m.next_wash ? ` · next ${prettyDate(m.next_wash.scheduled_date)}, ${slotLabel(m.next_wash.time_slot)}` : ''}</p>
                  </Link>
                  {m.washes_completed > 0 && <Link to={`/app/membership/${m.id}?tab=completed`} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-washo-300 hover:text-white"><Camera className="h-3.5 w-3.5" /> See the {m.washes_completed} wash{m.washes_completed > 1 ? 'es' : ''} done, with photos</Link>}
                  </div>
                ))}
              </div>
            ) : !open.length ? (
              <EmptyState title="Start your WASHO membership" text="Choose how many Body washes and Deep cleans you want each week, pick your days, and pay once. Every wash of your plan is scheduled for you." action={<ButtonLink to="/app/membership/new">Build my plan</ButtonLink>} />
            ) : null}
          </section>}

          <section aria-labelledby="up">
            <div className="mb-3 flex items-center justify-between"><h2 id="up" className="text-lg font-bold">Upcoming washes</h2><Link to="/app/bookings" className="text-sm font-semibold text-washo-300 hover:text-white">See all</Link></div>
            {upcoming.data?.length ? (
              <div className="space-y-3">{upcoming.data.slice(0, 4).map((b, i) => <BookingCard key={b.id} booking={b} index={i} />)}</div>
            ) : (
              <div className="panel flex items-center gap-3 p-5 text-sm text-fog"><CalendarDays className="h-5 w-5" /> Nothing scheduled yet.</div>
            )}
          </section>

          {completed.length > 0 && (
            <section aria-labelledby="done">
              <h2 id="done" className="mb-3 text-lg font-bold">Recently completed</h2>
              <div className="space-y-3">{completed.map((b, i) => <BookingCard key={b.id} booking={b} index={i} />)}</div>
            </section>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Link to="/app/book" className="panel flex items-center gap-3 p-4 text-sm font-semibold hover:border-white/20"><CalendarDays className="h-5 w-5 text-washo-300" /> Book a single wash</Link>
            <Link to="/app/vehicles" className="panel flex items-center gap-3 p-4 text-sm font-semibold hover:border-white/20"><Car className="h-5 w-5 text-washo-300" /> Manage vehicles</Link>
          </div>
        </div>
      )}
    </>
  );
}
