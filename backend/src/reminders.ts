import { campaignsNotInstalled } from './campaigns';
import { withApiRole } from './db';
import { renewalEmail, sendTracked } from './emails';
import { mailConfigured } from './notify';

/** How far ahead of the last day the reminder goes out. */
export const REMINDER_DAYS = 7;

interface DueRow {
  membership_id: string;
  full_name: string | null;
  email: string;
  vehicle_model: string | null;
  registration_number: string | null;
  end_date: string;
  ends_in_days: number;
  frequency_per_week: number | null;
  duration_months: number;
  washes_total: number;
  washes_done: number;
}

export interface ReminderRun {
  /** False when email is not set up (no RESEND_API_KEY) or the database does not have migration 18 yet. */
  ready: boolean;
  due: number;
  sent: number;
  already: number;
  failed: number;
  /** Dry run only: who would be emailed (the address is masked). */
  would?: { membership_id: string; to: string; ends_on: string; days_left: number }[];
}

const mask = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');

/**
 * Finds memberships that end within a week and emails each customer once, with a link that opens the plan ready to renew.
 * Safe to run as often as you like: the database remembers what has been sent (email_log), so nobody is emailed twice.
 */
export async function runRenewalReminders(o: { dryRun?: boolean } = {}): Promise<ReminderRun> {
  const out: ReminderRun = { ready: true, due: 0, sent: 0, already: 0, failed: 0 };
  if (!mailConfigured() && !o.dryRun) return { ...out, ready: false };
  let due: DueRow[];
  try {
    due = await withApiRole(async (c) => (await c.query('SELECT * FROM public.svc_membership_reminders_due($1, 50)', [REMINDER_DAYS])).rows as DueRow[]);
  } catch (err) {
    if (campaignsNotInstalled(err)) return { ...out, ready: false };
    throw err;
  }
  out.due = due.length;
  if (o.dryRun) return { ...out, would: due.map((d) => ({ membership_id: d.membership_id, to: mask(d.email), ends_on: d.end_date, days_left: d.ends_in_days })) };
  for (const d of due) {
    const r = await sendTracked('membership_renewal_reminder', d.membership_id, d.email, () =>
      renewalEmail({
        name: d.full_name, membershipId: d.membership_id, vehicle: d.vehicle_model, plate: d.registration_number, endDate: d.end_date, daysLeft: d.ends_in_days,
        washesDone: d.washes_done, washesTotal: d.washes_total, perWeek: d.frequency_per_week, months: d.duration_months,
      }), { requireLog: true });
    out[r] += 1;
  }
  return out;
}

const istHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date()));

/**
 * Looks for reminders to send every hour, between 9 in the morning and 8 at night Pune time (nobody wants a mail at 3 am). While the site is
 * asleep nothing runs, so POST /api/cron/reminders can also be called by an outside scheduler; either way nobody is emailed twice.
 */
export function startReminderScheduler(): () => void {
  const tick = () => {
    const h = istHour();
    if (h < 9 || h >= 20) return;
    runRenewalReminders()
      .then((r) => { if (r.sent || r.failed) console.log(`Renewal reminders: ${r.sent} sent, ${r.failed} failed, ${r.already} already sent.`); })
      .catch((e) => console.error('Renewal reminders failed:', (e as Error).message));
  };
  const first = setTimeout(tick, 2 * 60_000);
  const timer = setInterval(tick, 60 * 60_000);
  first.unref();
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
