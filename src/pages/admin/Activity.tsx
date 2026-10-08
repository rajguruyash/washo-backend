import { Search } from 'lucide-react';
import { useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { Badge, type Tone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { rupees } from '../../lib/format';
import { useAdminActivity } from '../../lib/queries';
import type { ActivityEvent } from '../../lib/types';
import { Loading } from './shared';

// What the database writes, in words a person reads. Anything not listed is shown as its own name, tidied.
const WORDS: Record<string, string> = {
  admin_signed_in: 'Signed in',
  admin_account_created: 'Added an admin',
  admin_role_changed: 'Changed an admin\'s role',
  admin_account_switched_off: 'Switched an admin off',
  admin_account_restored: 'Switched an admin back on',
  setting_changed: 'Changed a setting',
  data_exported: 'Downloaded an export',
  refund_approved: 'Approved a refund',
  refund_processed: 'Refund paid out',
  refund_failed: 'A refund failed',
  refund_requested: 'A refund was asked for',
  payment_settled: 'A payment was recorded',
  support_ticket_opened: 'A customer raised a complaint',
  support_replied: 'Answered a complaint',
  support_status_changed: 'Changed a complaint\'s status',
  pricing_setting_changed: 'Changed a pricing setting',
  discount_set: 'Set a discount',
  campaign_switched_off: 'Switched a campaign off',
  campaign_wash_claimed: 'A free wash was claimed',
  profile_restored: 'Restored a person',
  profile_archived: 'Switched a person off',
  customer_updated: 'Edited a customer',
  role_changed: 'Changed someone\'s role',
};
const TONE = (e: string): Tone => (/refund|payment|export|setting|admin_|role/.test(e) ? 'amber' : /fail|archiv|off/.test(e) ? 'red' : 'slate');
const words = (e: string) => WORDS[e] ?? e.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** The few facts worth reading at a glance from an event's details. Money is shown in rupees. */
function details(e: ActivityEvent): string {
  const m = e.metadata ?? {};
  const bits: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (v === null || v === undefined || v === '' || typeof v === 'object') continue;
    if (/amount_cents|threshold|cents/.test(k) && typeof v === 'number') bits.push(`${k.replace(/_cents$/, '').replace(/_/g, ' ')} ${rupees(v)}`);
    else bits.push(`${k.replace(/_/g, ' ')} ${String(v)}`);
  }
  return bits.slice(0, 5).join(' · ');
}

/** Who changed what, and when. The super admin's view. Search by what happened, by person, or by anything in the details. */
export default function Activity() {
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState('');
  const [limit, setLimit] = useState(100);
  const { data, isLoading, isError, refetch, isFetching } = useAdminActivity(q, limit);
  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); setQ(typed.trim()); setLimit(100); }} className="glass flex flex-wrap items-end gap-3 p-4">
        <Input className="min-w-[14rem] flex-1" label="Search the log" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="refund, setting, a person's name…" />
        <Button type="submit" icon={<Search className="h-4 w-4" />} loading={isFetching && !isLoading}>Search</Button>
        {q && <Button type="button" variant="ghost" onClick={() => { setQ(''); setTyped(''); }}>Clear</Button>}
      </form>
      <p className="text-sm text-fog">Every change an admin makes, every refund, every sign-in and every download is written here, with who did it. Times are Pune time. Nothing here can be edited or deleted.</p>
      {isError ? <ErrorState onRetry={() => void refetch()} /> : isLoading ? <Loading /> : !data?.length ? <div className="panel p-8 text-center text-fog">Nothing matches.</div> : (
        <>
          <ul className="panel divide-y divide-white/[0.07] overflow-hidden">
            {data.map((e) => (
              <li key={e.id} className="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[11rem_1fr]">
                <p className="text-xs text-fog sm:pt-1">{when(e.created_at)}</p>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm"><Badge tone={TONE(e.event_type)}>{words(e.event_type)}</Badge><span className="font-semibold">{e.actor_name ?? 'The system'}</span>{e.actor_role && <span className="text-xs text-fog">({e.actor_role})</span>}</p>
                  {details(e) && <p className="mt-1 break-words text-xs text-fog">{details(e)}</p>}
                </div>
              </li>
            ))}
          </ul>
          {data.length >= limit && limit < 500 && <div className="text-center"><Button variant="glass" loading={isFetching} onClick={() => setLimit((l) => Math.min(500, l + 100))}>Show older</Button></div>}
        </>
      )}
    </div>
  );
}
