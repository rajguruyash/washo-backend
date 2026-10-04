import { ArrowRight, BadgeCheck, CalendarDays, Car, Clock, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Plate } from '../../components/brand/Plate';
import { EmptyState, PageHeader } from '../../components/EmptyState';
import { BookingCard } from '../../components/WashBits';
import { Badge } from '../../components/ui/Badge';
import { ButtonLink } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Skeleton';
import { prettyDate } from '../../lib/format';
import { useBookings, useMemberships, useRequests } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { useAuth } from '../../state/auth';

export default function Dashboard() {
  const { user } = useAuth();
  const memberships = useMemberships();
  const requests = useRequests();
  const upcoming = useBookings('upcoming');
  const past = useBookings('past');
  const first = user?.full_name?.split(' ')[0];
  const open = requests.data?.filter((r) => ['submitted', 'quoted', 'accepted'].includes(r.status)) ?? [];
  const active = memberships.data?.filter((m) => m.status === 'active') ?? [];
  const completed = past.data?.filter((b) => b.status === 'completed').slice(0, 3) ?? [];
  const loading = memberships.isLoading || requests.isLoading;

  return (
    <>
      <PageHeader title={first ? `Hi, ${first}` : 'Welcome'} subtitle="Your washes, memberships and requests in one place." action={<ButtonLink to="/app/membership/new" icon={<Plus className="h-4 w-4" />}>Start a membership</ButtonLink>} />

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
      ) : (
        <div className="space-y-8">
          {open.map((r) => (
            <Link key={r.id} to={`/app/membership/requests/${r.id}`} className="glass flex items-center gap-4 border-washo-400/30 p-5 transition-colors hover:border-washo-400/60">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-washo-500/15 text-washo-300"><Clock className="h-6 w-6" /></span>
              <div className="min-w-0 flex-1">
                <p className="font-bold">{r.status === 'quoted' ? 'Your price is ready' : r.status === 'accepted' ? 'Finish your payment' : 'WASHO is reviewing your request'}</p>
                <p className="text-sm text-fog">{r.frequency_per_week} wash{r.frequency_per_week > 1 ? 'es' : ''} a week · {r.duration_months} month{r.duration_months > 1 ? 's' : ''} · {r.vehicle_model}</p>
              </div>
              <ArrowRight className="h-5 w-5 text-fog" />
            </Link>
          ))}

          {(active.length > 0 || !open.length) && <section aria-labelledby="mem">
            <h2 id="mem" className="mb-3 text-lg font-bold">Memberships</h2>
            {active.length ? (
              <div className="grid gap-4 md:grid-cols-2">
                {active.map((m) => (
                  <Link key={m.id} to={`/app/membership/${m.id}`} className="glass block p-5 transition-colors hover:border-washo-400/40">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="eyebrow">{m.reference_code}</p>
                        <p className="mt-1 text-lg font-bold">{m.frequency_per_week} wash{(m.frequency_per_week ?? 0) > 1 ? 'es' : ''} a week · {m.duration_months} mo</p>
                      </div>
                      <Badge tone="green" icon={<BadgeCheck className="h-3.5 w-3.5" />}>Active</Badge>
                    </div>
                    {m.registration_number && <Plate reg={m.registration_number} className="mt-3" />}
                    <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-washo-500 to-washo-300" style={{ width: `${m.washes_total ? (m.washes_completed / m.washes_total) * 100 : 0}%` }} /></div>
                    <p className="mt-2 text-xs text-fog">{m.washes_completed} of {m.washes_total} washes done{m.next_wash ? ` · next ${prettyDate(m.next_wash.scheduled_date)}, ${slotLabel(m.next_wash.time_slot)}` : ''}</p>
                  </Link>
                ))}
              </div>
            ) : !open.length ? (
              <EmptyState title="Start your WASHO membership" text="Choose 1, 2 or 3 washes a week. WASHO reviews your request and sends you a price. You only pay once you accept it." action={<ButtonLink to="/app/membership/new">Build my plan</ButtonLink>} />
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
