import { CalendarClock, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fullDate, istDay, todayIST } from '../lib/format';
import { useMemberships } from '../lib/queries';
import { useAuth } from '../state/auth';

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * A reminder on the customer's own pages, whether or not they have an email address: a membership that ends within a week (or ended in the last week) and has
 * not been renewed gets a card with a Renew button that opens the plan ready to renew. The emails say the same; this is for everyone the emails cannot reach.
 */
export function RenewalNotice() {
  const { user } = useAuth();
  const { data } = useMemberships();
  const today = todayIST();
  const due = (data ?? [])
    .filter((m) => (m.status === 'active' || m.status === 'expired') && m.vehicle_id)
    .map((m) => ({ m, left: daysBetween(today, istDay(m.end_at)) }))
    .filter(({ m, left }) => left <= 7 && left >= -7 && !(data ?? []).some((o) => o.id !== m.id && o.status === 'active' && o.vehicle_id === m.vehicle_id && o.end_at > m.end_at))
    .sort((a, b) => a.left - b.left)
    .slice(0, 2);
  if (!due.length) return null;
  return (
    <div className="space-y-3" role="region" aria-label="Membership renewal">
      {due.map(({ m, left }) => (
        <div key={m.id} className="glass border-warn/40 p-5">
          <div className="flex items-start gap-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-warn/15 text-warn"><CalendarClock className="h-6 w-6" aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <p className="font-bold">
                Your {m.vehicle_model ?? 'vehicle'}'s membership {left > 1 ? `ends in ${left} days` : left === 1 ? 'ends tomorrow' : left === 0 ? 'ends today' : 'has ended'}
              </p>
              <p className="mt-1 text-sm text-fog">
                {left >= 0 ? `Its last day is ${fullDate(istDay(m.end_at))}.` : `It ended on ${fullDate(istDay(m.end_at))}, so your regular washes have stopped.`} Renew in one tap: your plan is filled in, and you can change anything before you pay.
              </p>
              {!user?.email && <p className="mt-2 text-xs text-fog"><Link to="/app/account" className="font-semibold text-washo-300 hover:text-white">Add your email</Link> and we will also remind you by email next time.</p>}
            </div>
          </div>
          <Link to={`/app/membership/new?renew=${m.id}`} className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-b from-washo-500 to-washo-700 px-6 text-base font-semibold text-white shadow-[0_8px_24px_-8px_rgb(42_98_230/0.8),inset_0_1px_0_rgb(255_255_255/0.22)] transition-colors hover:from-washo-400 hover:to-washo-600">
            Renew my membership <ArrowRight className="h-5 w-5" aria-hidden />
          </Link>
        </div>
      ))}
    </div>
  );
}
