import { Download, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { canDo } from '../../lib/adminAccess';
import { addDays, todayIST } from '../../lib/format';
import { useAuth } from '../../state/auth';

const KINDS = [
  { kind: 'customers', title: 'Customers', about: 'Name, mobile number, email, when they joined, how many washes and memberships.', personal: true, dated: 'joined' },
  { kind: 'washes', title: 'Washes', about: 'Every wash: date, time, status, service, price, vehicle, society and specialist.', personal: false, dated: 'wash date' },
  { kind: 'memberships', title: 'Memberships', about: 'Plan, amount, status, start and end, washes booked and done.', personal: false, dated: 'start date' },
  { kind: 'payments', title: 'Payments', about: 'Every payment: when, amount, what for, status and the Razorpay ids. Customer name only.', personal: false, dated: 'paid on' },
  { kind: 'refunds', title: 'Refunds', about: 'Every refund: amount, status, reason and the Razorpay ids.', personal: false, dated: 'asked on' },
  { kind: 'support', title: 'Complaints', about: 'Every complaint: title, topic, status and the customer\'s name.', personal: false, dated: 'opened on' },
  { kind: 'activity', title: 'Activity log', about: 'Who did what and when, with the details.', personal: false, dated: 'date' },
] as const;

/** Download the data as a spreadsheet (CSV). Each export has its own permission, and every download is written to the activity log. */
export default function Export() {
  const { user } = useAuth();
  const [from, setFrom] = useState(addDays(todayIST(), -29));
  const [to, setTo] = useState(todayIST());
  const [all, setAll] = useState(false);
  const mine = KINDS.filter((k) => canDo(user?.admin, `export_${k.kind}`, 'manage'));
  const bad = !all && from > to;
  const href = (kind: string) => `/api/admin/export/${kind}${all ? '' : `?from=${from}&to=${to}`}`;
  return (
    <div className="space-y-5">
      <div className="glass flex flex-wrap items-end gap-4 p-4">
        <Input label="From" type="date" value={from} max={to} disabled={all} onChange={(e) => setFrom(e.target.value)} />
        <Input label="To" type="date" value={to} min={from} max={todayIST()} disabled={all} onChange={(e) => setTo(e.target.value)} />
        <label className="flex h-12 items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="h-4 w-4" /> Everything, from the start</label>
        {bad && <p role="alert" className="text-sm text-bad">The start date is after the end date.</p>}
      </div>
      <p className="flex items-start gap-2 text-sm text-fog"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden /> Exports are plain files that anyone who gets hold of them can read. Keep them to yourself, do not send them over chat, and delete them when you are done. Each download is written to the activity log with your name. A file holds at most 50,000 rows.</p>
      {mine.length === 0 ? <div className="panel p-8 text-center text-fog">Your role has no exports.</div> : (
        <div className="grid gap-4 md:grid-cols-2">
          {mine.map((k) => (
            <section key={k.kind} className="glass flex flex-col justify-between gap-4 p-5">
              <div>
                <h2 className="text-lg font-bold">{k.title}</h2>
                <p className="mt-1 text-sm text-fog">{k.about}</p>
                <p className="mt-2 text-xs text-fog/80">Dates are by {k.dated}.{k.personal && <span className="ml-1 font-semibold text-warn">Contains phone numbers and emails.</span>}</p>
              </div>
              <a href={bad ? undefined : href(k.kind)} download aria-disabled={bad} className={bad ? 'pointer-events-none opacity-50' : undefined}>
                <Button full variant="glass" icon={<Download className="h-4 w-4" />} disabled={bad} tabIndex={-1}>Download CSV</Button>
              </a>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
