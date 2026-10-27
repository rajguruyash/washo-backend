import { AlertTriangle, Banknote, Gift, LifeBuoy, LogIn, ShoppingBag, UserPlus, Undo2, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { cn } from '../../lib/cn';
import { prettyDate, rupees } from '../../lib/format';
import { useAdminDashboard, useAdminTrafficSummary } from '../../lib/queries';
import { teamLine } from '../../lib/traffic';
import type { AdminDashboard } from '../../lib/types';
import { Loading } from './shared';

export function Tile({ icon, label, value, sub, tone = 'default', onClick }: { icon: ReactNode; label: string; value: ReactNode; sub?: string; tone?: 'default' | 'warn' | 'bad'; onClick?: () => void }) {
  const body = (
    <>
      <span className={cn('grid h-9 w-9 place-items-center rounded-xl', tone === 'bad' ? 'bg-bad/15 text-bad' : tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-washo-500/15 text-washo-300')}>{icon}</span>
      <p className={cn('mt-3 font-display text-3xl font-extrabold tabular-nums', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn')}>{value}</p>
      <p className="mt-0.5 text-sm text-fog">{label}</p>
      {sub && <p className="mt-0.5 text-xs text-fog/80">{sub}</p>}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="glass p-4 text-left transition-colors hover:border-washo-400/40">{body}</button>
  ) : (
    <div className="glass p-4">{body}</div>
  );
}

/** A small green dot that pulses: something is live. */
export function LiveDot() {
  return (
    <span className="relative flex h-2.5 w-2.5" aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-ok" />
    </span>
  );
}

/**
 * Who is using WASHO: customers active in the last five minutes, customers who used it today, and customers who signed in today (specialists and admins are mentioned underneath, not counted
 * in the number). Each opens the Traffic tab. Until the database has been set up for it (migration 50) they show dashes and say so.
 */
function TrafficTiles({ go }: { go: () => void }) {
  const { data, isLoading } = useAdminTrafficSummary();
  const s = data?.summary ?? null;
  const off = !isLoading && data && !data.ready;
  const dash = isLoading ? '…' : '–';
  return (
    <>
      <Tile icon={<LiveDot />} label="Customers active now" value={s ? s.active_now.customers : dash} sub={off ? 'Not switched on yet. Open to see how.' : s ? teamLine(s.active_now) || `in the last ${s.window_minutes} minutes` : undefined} onClick={go} />
      <Tile icon={<Users className="h-[18px] w-[18px]" />} label="Customers active today" value={s ? s.active_today.customers : dash} sub={s ? teamLine(s.active_today) || 'used WASHO today' : undefined} onClick={go} />
      <Tile icon={<LogIn className="h-[18px] w-[18px]" />} label="Customers signed in today" value={s ? s.signed_in_today.customers : dash} sub={s ? `${s.signed_in_today.sign_ins} sign-in${s.signed_in_today.sign_ins === 1 ? '' : 's'} in all${s.signed_in_today.workers + s.signed_in_today.admins > 0 ? ', incl. team' : ''}` : undefined} onClick={go} />
    </>
  );
}

/** Fourteen days as bars: how many paid orders each day (and what was collected, for a role that may see money). Plain bars, with the numbers readable underneath. */
function Series({ d }: { d: AdminDashboard }) {
  const money = d.money !== null;
  const values = d.series.map((s) => (money ? (s.collected_cents ?? 0) : s.paid_orders));
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <section className="glass p-5" aria-label={money ? 'Money collected, last 14 days' : 'Paid orders, last 14 days'}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">{money ? 'Money collected' : 'Paid orders'}, last 14 days</h2>
        <p className="text-sm text-fog">{money ? rupees(total) : `${total} orders`} in all</p>
      </div>
      <div className="mt-4 flex h-32 items-end gap-1.5" role="list">
        {d.series.map((s, i) => {
          const v = values[i];
          return (
            <div key={s.date} role="listitem" className="group flex h-full flex-1 flex-col justify-end" title={`${prettyDate(s.date)}: ${money ? rupees(s.collected_cents ?? 0) : `${s.paid_orders} orders`}, ${s.new_customers} new customers`}>
              <div className={cn('w-full rounded-t-md transition-colors', s.date === d.today ? 'bg-washo-400' : 'bg-washo-500/50 group-hover:bg-washo-400/80')} style={{ height: `${v ? Math.max(4, (v / max) * 100) : 2}%`, opacity: v ? 1 : 0.35 }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-fog"><span>{prettyDate(d.series[0].date)}</span><span>Today</span></div>
    </section>
  );
}

/** Today's key numbers: new customers, paid orders, money in and out, payments that went wrong, complaints waiting. What a role may not see is simply not shown. */
export function Dashboard({ go, traffic = false }: { go: (tab: 'attention' | 'support' | 'traffic') => void; /** Show the traffic tiles (the role has Activity access). */ traffic?: boolean }) {
  const { data: d, isLoading, isError, refetch } = useAdminDashboard();
  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !d) return <Loading />;
  const problems = d.payment_problems ? d.payment_problems.failed_today + d.payment_problems.unfulfilled + d.payment_problems.unconfirmed_checkouts : 0;
  return (
    <section className="mb-8 space-y-4" aria-label="Today">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-lg font-bold">Today</h2><p className="text-sm text-fog">{prettyDate(d.today)} · Pune time</p></div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {traffic && <TrafficTiles go={() => go('traffic')} />}
        <Tile icon={<UserPlus className="h-[18px] w-[18px]" />} label="New customers" value={d.new_customers.today} sub={`${d.new_customers.last_7_days} this week · ${d.new_customers.last_30_days} this month`} />
        <Tile icon={<ShoppingBag className="h-[18px] w-[18px]" />} label="Paid orders" value={d.orders.paid_today} sub={`${d.orders.paid_last_7_days} in 7 days`} />
        <Tile icon={<Gift className="h-[18px] w-[18px]" />} label="Free washes claimed" value={d.orders.free_washes_today} />
        {d.open_complaints !== null && <Tile icon={<LifeBuoy className="h-[18px] w-[18px]" />} label="Complaints waiting" value={d.open_complaints} tone={d.open_complaints > 0 ? 'warn' : 'default'} onClick={() => go('support')} />}
        {d.money && (
          <>
            <Tile icon={<Banknote className="h-[18px] w-[18px]" />} label="Collected today" value={rupees(d.money.collected_today_cents)} sub={`${rupees(d.money.collected_7_days_cents)} in 7 days · ${rupees(d.money.collected_30_days_cents)} in 30`} />
            <Tile icon={<Undo2 className="h-[18px] w-[18px]" />} label="Refunded today" value={rupees(d.money.refunded_today_cents)} sub={`${rupees(d.money.refunded_30_days_cents)} in 30 days`} />
          </>
        )}
        {d.payment_problems && (
          <Tile
            icon={<AlertTriangle className="h-[18px] w-[18px]" />}
            label="Payments that went wrong"
            value={problems}
            tone={problems > 0 ? 'bad' : 'default'}
            sub={problems ? `${d.payment_problems.failed_today} failed today · ${d.payment_problems.unfulfilled} not booked · ${d.payment_problems.unconfirmed_checkouts} unconfirmed` : 'Nothing needs you'}
            onClick={() => go('attention')}
          />
        )}
      </div>
      <Series d={d} />
    </section>
  );
}
