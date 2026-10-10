import { campaignsNotInstalled } from './campaigns';
import { withApiRole } from './db';
import { renewalEmail, sendTracked, type RenewalStage } from './emails';
import { mailConfigured } from './notify';

/**
 * Three renewal emails for a membership, each sent once per membership (the database remembers: email_log):
 *   week   before the last day                    (by default ends in 1 to 7 days)
 *   last   the last days                           (by default ends in 0 to 2 days; only after the first went out at least 2 days earlier)
 *   ended  once it is over, if it was not renewed  (by default ended 1 to 3 days ago)
 * Never to someone who has already renewed, and never two within 24 hours (both enforced in the database, migration 29).
 * The Admin page controls them (migration 30): the whole automatic job on or off, each step on or off, how many days, and the hours of the day.
 */
export interface RenewalSettings {
  on: boolean;
  week: { on: boolean; days: number };
  last: { on: boolean; days: number };
  ended: { on: boolean; days: number };
  from_hour: number;
  to_hour: number;
}
export const DEFAULT_SETTINGS: RenewalSettings = { on: true, week: { on: true, days: 7 }, last: { on: true, days: 2 }, ended: { on: true, days: 3 }, from_hour: 9, to_hour: 20 };

export const KIND: Record<RenewalStage, string> = { week: 'membership_renewal_reminder', last: 'membership_renewal_last_call', ended: 'membership_renewal_ended' };

interface Stage { stage: RenewalStage; kind: string; from: number; to: number; requires: { kind: string; days: number } | null }

/** The steps that are switched on, with their windows. The last-days email follows the first only when the first is on. */
export function stagesFor(cfg: RenewalSettings): Stage[] {
  const out: Stage[] = [];
  if (cfg.week.on) out.push({ stage: 'week', kind: KIND.week, from: 1, to: cfg.week.days, requires: null });
  if (cfg.last.on) out.push({ stage: 'last', kind: KIND.last, from: 0, to: cfg.last.days, requires: cfg.week.on ? { kind: KIND.week, days: 2 } : null });
  if (cfg.ended.on) out.push({ stage: 'ended', kind: KIND.ended, from: -cfg.ended.days, to: -1, requires: null });
  return out;
}

/** The settings from the database. A database without migration 30 simply runs on the defaults, which are what the emails always did. */
export async function loadRenewalSettings(): Promise<RenewalSettings> {
  try {
    const s = (await withApiRole(async (c) => (await c.query('SELECT public.svc_renewal_settings() AS s')).rows[0].s)) as RenewalSettings;
    return { ...DEFAULT_SETTINGS, ...s };
  } catch (err) {
    if (campaignsNotInstalled(err)) return DEFAULT_SETTINGS;
    throw err;
  }
}

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
  /** The automatic job is switched off in Admin, or it is outside the sending hours (a person pressing "Send now" is never held back by either). */
  paused?: 'switched_off' | 'outside_hours';
  /** Dry run only: who would be emailed (the address is masked). */
  would?: { stage: RenewalStage; membership_id: string; to: string; ends_on: string; days_left: number }[];
}

const mask = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');

/** Who is due for one step. A database without migration 29 only knows the first step (through the older function). */
async function dueFor(s: Stage): Promise<DueRow[]> {
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
export async function runRenewalReminders(o: { dryRun?: boolean; manual?: boolean } = {}): Promise<ReminderRun> {
  const out: ReminderRun = { ready: true, due: 0, sent: 0, already: 0, failed: 0, stages: [] };
  if (!mailConfigured() && !o.dryRun) return { ...out, ready: false };
  const cfg = await loadRenewalSettings();
  // The automatic job (the hourly timer and the outside scheduler) keeps to the switch and the hours set in Admin. A person pressing a button does not.
  if (!o.manual) {
    if (!cfg.on) return { ...out, paused: 'switched_off' };
    const h = istHour();
    if (h < cfg.from_hour || h >= cfg.to_hour) return { ...out, paused: 'outside_hours' };
  }
  const would: NonNullable<ReminderRun['would']> = [];
  for (const s of stagesFor(cfg)) {
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
        const r = await sendRenewal(s.stage, d);
        run[r] += 1;
        out[r] += 1;
      }
    }
    out.stages.push(run);
  }
  return o.dryRun ? { ...out, would } : out;
}

/** Sends one membership one step of the renewal emails (once: the database refuses a second send of the same step). Also used by "Send now" in Admin. */
export async function sendRenewal(stage: RenewalStage, d: Omit<DueRow, 'email'> & { email: string }) {
  return sendTracked(KIND[stage], d.membership_id, d.email, () =>
    renewalEmail({
      name: d.full_name, membershipId: d.membership_id, vehicle: d.vehicle_model, plate: d.registration_number, endDate: d.end_date, daysLeft: d.ends_in_days,
      washesDone: d.washes_done, washesTotal: d.washes_total, perWeek: d.frequency_per_week, perMonth: d.washes_per_month, months: d.duration_months,
    }, stage), { requireLog: true });
}

const istHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date()));

/**
 * Looks for renewal emails to send every hour; the switch and the hours of the day (set in Admin, 9 am to 8 pm Pune time to begin with: nobody wants a
 * mail at 3 am) are checked inside the job. While the site is asleep nothing runs, so POST /api/cron/reminders can also be called by an outside
 * scheduler; either way nobody is emailed twice.
 */
export function startReminderScheduler(): () => void {
  const tick = () => {
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
