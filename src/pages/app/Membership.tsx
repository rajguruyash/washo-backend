import { BadgeCheck, ChevronRight, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Plate } from '../../components/brand/Plate';
import { EmptyState, ErrorState, PageHeader } from '../../components/EmptyState';
import { patternLabel } from '../../components/WashBits';
import { Badge } from '../../components/ui/Badge';
import { ButtonLink } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Skeleton';
import { fullDate, prettyDate } from '../../lib/format';
import { useMemberships, useRequests } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';

const reqLabel: Record<string, { label: string; tone: 'amber' | 'blue' | 'green' | 'red' | 'slate' }> = {
  submitted: { label: 'With WASHO', tone: 'amber' },
  quoted: { label: 'Price ready', tone: 'blue' },
  accepted: { label: 'Awaiting payment', tone: 'blue' },
  active: { label: 'Active', tone: 'green' },
  rejected: { label: 'Not available', tone: 'red' },
  declined: { label: 'Declined', tone: 'slate' },
  expired: { label: 'Expired', tone: 'slate' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
};

export default function Membership() {
  const memberships = useMemberships();
  const requests = useRequests();
  // Active requests are already shown as memberships.
  const reqs = requests.data?.filter((r) => r.status !== 'active') ?? [];

  return (
    <>
      <PageHeader title="Membership" subtitle="Your custom plan: you choose the washes, days and length. WASHO confirms the price." action={<ButtonLink to="/app/membership/new" icon={<Plus className="h-4 w-4" />}>New request</ButtonLink>} />
      {memberships.isError || requests.isError ? (
        <ErrorState onRetry={() => { void memberships.refetch(); void requests.refetch(); }} />
      ) : memberships.isLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="space-y-10">
          {reqs.length > 0 && (
            <section aria-labelledby="reqs">
              <h2 id="reqs" className="mb-3 text-lg font-bold">Requests</h2>
              <div className="space-y-3">
                {reqs.map((r) => (
                  <Link key={r.id} to={`/app/membership/requests/${r.id}`} className="glass group flex items-center gap-4 p-4 transition-colors hover:border-washo-400/40">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-bold">{r.frequency_per_week} a week · {r.duration_months} month{r.duration_months > 1 ? 's' : ''} <Badge tone={reqLabel[r.status].tone}>{reqLabel[r.status].label}</Badge></p>
                      <p className="mt-1 text-xs text-fog">{r.reference_code} · {r.vehicle_model} · {patternLabel(r.weekly_pattern)}</p>
                    </div>
                    <ChevronRight className="h-5 w-5 text-fog transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section aria-labelledby="mine">
            <h2 id="mine" className="mb-3 text-lg font-bold">Your memberships</h2>
            {memberships.data?.length ? (
              <div className="grid gap-4 md:grid-cols-2">
                {memberships.data.map((m) => (
                  <Link key={m.id} to={`/app/membership/${m.id}`} className="glass block p-5 transition-colors hover:border-washo-400/40">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="eyebrow">{m.reference_code}</p>
                        <p className="mt-1 text-lg font-bold">{m.frequency_per_week} wash{(m.frequency_per_week ?? 0) > 1 ? 'es' : ''} a week · {m.duration_months} mo</p>
                        {m.weekly_pattern && <p className="mt-1 text-xs text-fog">{patternLabel(m.weekly_pattern)}{m.time_slot ? ` · ${slotLabel(m.time_slot)}` : ''}</p>}
                      </div>
                      <Badge tone={m.status === 'active' ? 'green' : 'slate'} icon={<BadgeCheck className="h-3.5 w-3.5" />}>{m.status === 'active' ? 'Active' : m.status}</Badge>
                    </div>
                    {m.registration_number && <Plate reg={m.registration_number} className="mt-3" />}
                    <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-washo-500 to-washo-300" style={{ width: `${m.washes_total ? (m.washes_completed / m.washes_total) * 100 : 0}%` }} /></div>
                    <p className="mt-2 text-xs text-fog">{m.washes_completed} of {m.washes_total} done · until {fullDate(m.end_at.slice(0, 10))}{m.next_wash ? ` · next ${prettyDate(m.next_wash.scheduled_date)}` : ''}</p>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState title="No membership yet" text="Choose 1 to 7 washes a week. WASHO reviews your request and sends you a price. You only pay once you accept it." action={<ButtonLink to="/app/membership/new">Build my plan</ButtonLink>} />
            )}
          </section>
        </div>
      )}
    </>
  );
}
