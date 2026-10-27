import { Activity as PulseIcon, LogIn, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { PhoneAction } from '../../components/PhoneAction';
import { Badge, type Tone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { cn } from '../../lib/cn';
import { prettyDate } from '../../lib/format';
import { useAdminTraffic } from '../../lib/queries';
import { METHOD_LABEL, ROLE_WORD, SOURCE_WORD, ago, barHeight, clock, teamLine } from '../../lib/traffic';
import type { TrafficDay, TrafficPerson, TrafficRole, TrafficSignIn, TrafficSource } from '../../lib/types';
import { LiveDot, Tile } from './Dashboard';
import { Loading } from './shared';

const ROLE_TONE: Record<TrafficRole, Tone> = { customer: 'blue', worker: 'amber', admin: 'slate' };
const SOURCE_TONE: Record<TrafficSource, Tone> = { website: 'slate', app: 'green' };
const SHOWN = 100; // lists show this many until "Show all"

/** A clock that ticks, so "4 min ago" stays true between refreshes of the data. */
function useNow(everyMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

/** Someone's name with how to reach them (a mobile number you can tap to call or message, else their email). */
function Who({ p }: { p: { name: string; phone: string | null; email: string | null; role: TrafficRole } }) {
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-2 font-semibold"><span className="truncate">{p.name}</span> <Badge tone={ROLE_TONE[p.role]}>{ROLE_WORD[p.role]}</Badge></p>
      <p className="truncate text-xs text-fog">
        {p.phone ? <PhoneAction phone={p.phone} message={`Hi ${firstName(p.name)}, this is WASHO.`} className="font-medium text-washo-300 underline decoration-washo-300/40 underline-offset-2 hover:text-white" /> : p.email ?? 'No contact on file'}
      </p>
    </div>
  );
}

/** The last days as pairs of bars: customers who used WASHO that day, and customers who signed in. Tap a day to see its people and sign-ins below. */
function Series({ days, chosen, onPick }: { days: TrafficDay[]; chosen: string; onPick: (date: string) => void }) {
  const max = Math.max(1, ...days.flatMap((d) => [d.customers_active, d.customers_signed_in]));
  const total = days.reduce((n, d) => n + d.customers_active, 0);
  return (
    <section className="glass p-5" aria-label={`Customers active each day, last ${days.length} days`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">Customers per day, last {days.length} days</h2>
        <p className="text-sm text-fog">{total} customer-days in all</p>
      </div>
      <div className="mt-4 flex h-32 items-end gap-1.5" role="list">
        {days.map((d) => (
          <div key={d.date} role="listitem" className="flex h-full flex-1 flex-col justify-end">
            <button
              type="button"
              onClick={() => onPick(d.date)}
              aria-label={`${prettyDate(d.date)}: ${d.customers_active} customers active, ${d.customers_signed_in} signed in. Show this day.`}
              aria-pressed={d.date === chosen}
              title={`${prettyDate(d.date)}: ${d.customers_active} active · ${d.customers_signed_in} signed in · ${d.team_active} team`}
              className={cn('group flex h-full w-full items-end justify-center gap-0.5 rounded-md px-0.5 transition-colors', d.date === chosen ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]')}
            >
              <span className="w-full max-w-3 rounded-t-sm bg-washo-400" style={{ height: `${barHeight(d.customers_active, max)}%`, opacity: d.customers_active ? 1 : 0.35 }} />
              <span className="w-full max-w-3 rounded-t-sm bg-ok/70" style={{ height: `${barHeight(d.customers_signed_in, max)}%`, opacity: d.customers_signed_in ? 1 : 0.35 }} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-fog"><span>{prettyDate(days[0].date)}</span><span>Today</span></div>
      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fog">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-washo-400" /> Customers who used WASHO</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-ok/70" /> Customers who signed in</span>
      </p>
    </section>
  );
}

function Rows<T>({ rows, render, empty, label }: { rows: T[]; render: (r: T, i: number) => React.ReactNode; empty: string; label: string }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <p className="panel p-5 text-sm text-fog">{empty}</p>;
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <div>
      <ul className="space-y-2" aria-label={label}>{shown.map((r, i) => <li key={i} className="panel flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3.5">{render(r, i)}</li>)}</ul>
      {rows.length > SHOWN && !all && <div className="mt-3"><Button size="sm" variant="glass" onClick={() => setAll(true)}>Show all {rows.length}</Button></div>}
    </div>
  );
}

/** Shown until migration 50 has been applied: there is nothing to read yet. */
function NotReady() {
  return (
    <div className="glass max-w-2xl p-6" role="status">
      <h2 className="text-lg font-bold">Traffic is not switched on yet</h2>
      <p className="mt-2 text-sm text-fog">
        It needs one small addition to the database (two tables and the functions that read them; nothing that exists changes). Paste <strong className="text-white">supabase/apply/apply_50_traffic.sql</strong> into the
        Supabase SQL Editor and Run it, once. From then on every sign-in is recorded and the dashboard shows who is active; people who signed in before it was applied show up as they next use WASHO.
      </p>
    </div>
  );
}

/**
 * Traffic: who is using WASHO. Signed-in people only (a visitor who has not signed in is not recorded). "Active now" is anyone who used the site or the app in the last 5 minutes; a day is a Pune day.
 * The numbers at the top are the ones on the dashboard; below them, who is on right now, who was active on the chosen day, and every sign-in that day.
 */
export default function Traffic() {
  const [day, setDay] = useState<string | null>(null); // null = today
  const { data: d, isLoading, isError, refetch, isFetching } = useAdminTraffic(day);
  const now = useNow();
  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !d) return <Loading />;
  if (!d.ready) return <NotReady />;

  const isToday = d.day === d.today;
  const { active_now: an, active_today: at, signed_in_today: si } = d.summary;
  const pick = (date: string) => setDay(date === d.today ? null : date);
  const customersThatDay = d.people.filter((p) => p.role === 'customer').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold">Traffic</h2>
          <p className="mt-1 max-w-2xl text-sm text-fog">
            People who are signed in. Someone who has not signed in is not counted. <strong className="text-mist">Active</strong> means they used the site or the app in the last {d.summary.window_minutes} minutes.
            Updates every 30 seconds{isFetching ? ' · refreshing' : ''}.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Input label="Day" type="date" value={d.day} max={d.today} onChange={(e) => setDay(e.target.value && e.target.value !== d.today ? e.target.value : null)} />
          {!isToday && <Button variant="glass" onClick={() => setDay(null)}>Today</Button>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Tile icon={<LiveDot />} label="Customers active now" value={an.customers} sub={teamLine(an) || `in the last ${d.summary.window_minutes} minutes`} />
        <Tile icon={<Users className="h-[18px] w-[18px]" />} label="Customers active today" value={at.customers} sub={teamLine(at) || 'used WASHO today'} />
        <Tile icon={<LogIn className="h-[18px] w-[18px]" />} label="Customers signed in today" value={si.customers} sub={`${si.sign_ins} sign-in${si.sign_ins === 1 ? '' : 's'} in all${si.workers + si.admins ? ` · ${teamLine({ customers: 0, workers: si.workers, admins: si.admins }).replace('+ ', 'incl. ')}` : ''}`} />
      </div>

      {isToday && (
        <section aria-label="On the site right now">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-bold"><PulseIcon className="h-5 w-5 text-ok" /> On the site right now <span className="text-sm font-normal text-fog">({d.live.length})</span></h2>
          <Rows
            rows={d.live}
            label="People on the site right now"
            empty={`Nobody is on the site right now (nobody has used it in the last ${d.summary.window_minutes} minutes).`}
            render={(p: TrafficPerson) => (
              <>
                <Who p={p} />
                <div className="flex items-center gap-2"><Badge tone={SOURCE_TONE[p.source]}>{SOURCE_WORD[p.source]}</Badge><span className="text-sm text-mist">{ago(p.last_seen_at, now)}</span></div>
              </>
            )}
          />
        </section>
      )}

      <Series days={d.days} chosen={d.day} onPick={pick} />

      <section aria-label={`People active on ${prettyDate(d.day)}`}>
        <h2 className="mb-1 text-lg font-bold">Active {isToday ? 'today' : prettyDate(d.day)} <span className="text-sm font-normal text-fog">({customersThatDay} customer{customersThatDay === 1 ? '' : 's'}{d.people.length > customersThatDay ? `, ${d.people.length - customersThatDay} team` : ''})</span></h2>
        <p className="mb-3 text-sm text-fog">Everyone who used WASHO that day, most recent first.</p>
        <Rows
          rows={d.people}
          label="People active on the chosen day"
          empty="Nobody used WASHO on this day."
          render={(p: TrafficPerson) => (
            <>
              <Who p={p} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-mist">
                <span>{p.first_seen_at ? `${clock(p.first_seen_at)} to ` : ''}{clock(p.last_seen_at)}</span>
                {(p.sign_ins ?? 0) > 0 && <span className="text-fog">signed in {p.sign_ins}×</span>}
                <Badge tone={SOURCE_TONE[p.source]}>{SOURCE_WORD[p.source]}</Badge>
              </div>
            </>
          )}
        />
      </section>

      <section aria-label={`Sign-ins on ${prettyDate(d.day)}`}>
        <h2 className="mb-1 text-lg font-bold">Sign-ins {isToday ? 'today' : `on ${prettyDate(d.day)}`} <span className="text-sm font-normal text-fog">({d.sign_ins.length})</span></h2>
        <p className="mb-3 text-sm text-fog">Each time someone signed in, and how. Someone who stays signed in for days is active without signing in again, so this is shorter than the list above.</p>
        <Rows
          rows={d.sign_ins}
          label="Sign-ins on the chosen day"
          empty="Nobody signed in on this day."
          render={(e: TrafficSignIn) => (
            <>
              <Who p={e} />
              <div className="flex flex-wrap items-center gap-2 text-sm text-mist"><span>{clock(e.at)}</span><span className="text-fog">{METHOD_LABEL[e.method]}</span><Badge tone={SOURCE_TONE[e.source]}>{SOURCE_WORD[e.source]}</Badge></div>
            </>
          )}
        />
      </section>
    </div>
  );
}
