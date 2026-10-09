import { campaignsNotInstalled } from './campaigns';
import { withApiRole } from './db';
import { renewalEmail, sendTracked, type RenewalStage } from './emails';
import { mailConfigured } from './notify';

/**
 * Three renewal emails for a membership, each sent once per membership (the database remembers: email_log):
 *   week   a week before the last day                      (ends in 1 to 7 days)
 *   last   the last days                                    (ends in 0 to 2 days; only after the first went out at least 2 days earlier)
 *   ended  once it is over, if it was not renewed           (ended 1 to 3 days ago)
 * Never to someone who has already renewed, and never two within 24 hours (both enforced in the database, migration 29).
 */
export const STAGES: { stage: RenewalStage; kind: string; from: number; to: number; requires: { kind: string; days: number } | null }[] = [
  { stage: 'week', kind: 'membership_renewal_reminder', from: 1, to: 7, requires: null },
  { stage: 'last', kind: 'membership_renewal_last_call', from: 0, to: 2, requires: { kind: 'membership_renewal_reminder', days: 2 } },
  { stage: 'ended', kind: 'membership_renewal_ended', from: -3, to: -1, requires: null },
];

interface DueRow {
  membership_id: string;
  full_name: string | null;
  email: string;
  vehicle_model: string | null;
  registration_number: string | null;
  end_date: string;
  ends_in_days: number;
  frequency_per_week: number | null;
  washes_per_month: number | null;
  duration_months: number;
  washes_total: number;
  washes_done: number;
}

export interface StageRun { stage: RenewalStage; due: number; sent: number; already: number; failed: number }

export interface ReminderRun {
  /** False when email is not set up (no RESEND_API_KEY) or the database does not have the reminder migrations yet. */
  ready: boolean;
  /** Totals across the three steps. */
  due: number;
  sent: number;
  already: number;
  failed: number;
  stages: StageRun[];
  /** Dry run only: who would be emailed (the address is masked). */
  would?: { stage: RenewalStage; membership_id: string; to: string; ends_on: string; days_left: number }[];
}

const mask = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');

/** Who is due for one step. A database without migration 29 only knows the first step (through the older function). */
async function dueFor(s: (typeof STAGES)[number]): Promise<DueRow[]> {
  try {
    return await withApiRole(async (c) => (await c.query('SELECT * FROM public.svc_membership_renewals_due($1, $2, $3, $4, $5, 50)', [s.kind, s.from, s.to, s.requires?.kind ?? null, s.requires?.days ?? 0])).rows as DueRow[]);
  } catch (err) {
    if (!campaignsNotInstalled(err)) throw err;
    if (s.stage !== 'week') return [];
    return withApiRole(async (c) => (await c.query('SELECT * FROM public.svc_membership_reminders_due(7, 50)')).rows as DueRow[]);
  }
}

/**
 * Finds memberships that are about to end (or just have) and emails each customer the right step once, with a link that opens the plan ready to renew.
 * Safe to run as often as you like: the database remembers what has been sent, so nobody is emailed twice.
 */
export async function runRenewalReminders(o: { dryRun?: boolean } = {}): Promise<ReminderRun> {
  const out: ReminderRun = { ready: true, due: 0, sent: 0, already: 0, failed: 0, stages: [] };
  if (!mailConfigured() && !o.dryRun) return { ...out, ready: false };
  const would: NonNullable<ReminderRun['would']> = [];
  for (const s of STAGES) {
    let due: DueRow[];
    try {
      due = await dueFor(s);
    } catch (err) {
      if (campaignsNotInstalled(err)) return { ...out, ready: false };
      throw err;
    }
    const run: StageRun = { stage: s.stage, due: due.length, sent: 0, already: 0, failed: 0 };
    out.due += due.length;
    if (o.dryRun) {
      would.push(...due.map((d) => ({ stage: s.stage, membership_id: d.membership_id, to: mask(d.email), ends_on: d.end_date, days_left: d.ends_in_days })));
    } else {
      for (const d of due) {
        const r = await sendTracked(s.kind, d.membership_id, d.email, () =>
          renewalEmail({
            name: d.full_name, membershipId: d.membership_id, vehicle: d.vehicle_model, plate: d.registration_number, endDate: d.end_date, daysLeft: d.ends_in_days,
            washesDone: d.washes_done, washesTotal: d.washes_total, perWeek: d.frequency_per_week, perMonth: d.washes_per_month, months: d.duration_months,
          }, s.stage), { requireLog: true });
        run[r] += 1;
        out[r] += 1;
      }
    }
    out.stages.push(run);
  }
  return o.dryRun ? { ...out, would } : out;
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
      .then((r) => { if (r.sent || r.failed) console.log(`Renewal emails: ${r.sent} sent, ${r.failed} failed, ${r.already} already sent (${r.stages.map((s) => `${s.stage} ${s.sent}`).join(', ')}).`); })
      .catch((e) => console.error('Renewal emails failed:', (e as Error).message));
  };
  const first = setTimeout(tick, 2 * 60_000);
  const timer = setInterval(tick, 60 * 60_000);
  first.unref();
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
