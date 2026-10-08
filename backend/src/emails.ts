import { campaignsNotInstalled } from './campaigns';
import { config } from './config';
import { withApiRole } from './db';
import { sendMail } from './notify';

/**
 * The emails WASHO sends customers (through Resend; RESEND_API_KEY and EMAIL_FROM are set on the server):
 *   free_wash_confirmation        right after someone claims a campaign's free wash
 *   membership_renewal_reminder   a week before a membership ends, with a link that opens the plan again, ready to renew
 * Each goes out once: sendTracked() asks the database (email_log, migration 18) for the right to send before it sends.
 */

const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const site = () => config.publicUrl || 'https://washo.online';

type Slot = 'morning' | 'afternoon' | 'night';
const SLOT_NAME: Record<Slot, string> = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' };
const SLOT_WINDOW: Record<Slot, string> = { morning: '7:00 – 11:00 AM', afternoon: '12:00 – 4:00 PM', night: '7:00 – 10:00 PM' };

const fmt = (date: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { ...o, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const longDate = (d: string) => fmt(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = (d: string) => fmt(d, { weekday: 'short', day: 'numeric', month: 'short' });
const firstName = (n: string | null) => n?.trim().split(/\s+/)[0] || 'there';
const pct = (bp: number) => `${bp / 100}%`;

/** One simple, phone-friendly layout for every email: WASHO header, a heading, the body, an optional button, a footer. */
function layout(o: { preheader: string; heading: string; body: string; cta?: { label: string; url: string }; foot?: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(o.heading)}</title></head><body style="margin:0;padding:0;background:#f1f5f9">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(o.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
    <tr><td style="padding:0 4px 14px;font-size:26px;font-weight:800;letter-spacing:-0.5px;color:#1248b8;font-style:italic">WASHO</td></tr>
    <tr><td style="background:#ffffff;border-radius:16px;padding:28px 26px;border:1px solid #e2e8f0">
      <h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:#0f172a">${esc(o.heading)}</h1>
      ${o.body}
      ${o.cta ? `<p style="margin:24px 0 4px"><a href="${esc(o.cta.url)}" style="display:inline-block;background:#1248b8;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:12px">${esc(o.cta.label)}</a></p>` : ''}
      ${o.foot ? `<p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#64748b">${o.foot}</p>` : ''}
    </td></tr>
    <tr><td style="padding:16px 8px;font-size:12px;line-height:1.5;color:#94a3b8;text-align:center">WASHO · Doorstep car and bike washing, Kharadi, Pune<br>Questions? Just reply to this email, or call 86688 90147.</td></tr>
  </table>
</td></tr></table></body></html>`;
}

const row = (k: string, v: string) => `<tr><td style="padding:7px 0;color:#64748b;font-size:14px;width:120px;vertical-align:top">${esc(k)}</td><td style="padding:7px 0;font-size:14px;font-weight:600">${v}</td></tr>`;
const p = (html: string) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#334155">${html}</p>`;

// ───────────────────────── free wash confirmation ─────────────────────────
export interface FreeWashEmail {
  name: string | null;
  bookingId: string;
  reference: string;
  date: string; // YYYY-MM-DD
  slot: Slot;
  service: string;
  vehicle: string;
  plate: string;
  society: string | null;
  block: string | null;
  flat: string | null;
  parking: string | null;
  campaign: string;
  claimsCloseOn: string; // YYYY-MM-DD
  offer: { days: number; bp1: number; bp2: number; bp3: number };
}

export function freeWashEmail(d: FreeWashEmail): { subject: string; html: string } {
  const where = [d.society, d.block && `Block ${d.block}`, d.flat].filter(Boolean).join(', ');
  const body =
    p(`Hi ${esc(firstName(d.name))}, your free ${esc(d.service)} is booked. Nothing to pay.`) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 14px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0">` +
    row('Reference', esc(d.reference)) +
    row('When', `${esc(longDate(d.date))}<br><span style="font-weight:400;color:#475569">${esc(SLOT_NAME[d.slot])}, ${esc(SLOT_WINDOW[d.slot])}</span>`) +
    row('Vehicle', `${esc(d.vehicle)} · ${esc(d.plate)}`) +
    (where ? row('Where', esc(where) + (d.parking ? `<br><span style="font-weight:400;color:#475569">Parking: ${esc(d.parking)}</span>` : '')) : '') +
    `</table>` +
    p('<strong>What happens next:</strong> your specialist calls you before they arrive, washes the vehicle at your parking spot, and you will see the before and after photos in your WASHO account.') +
    p(`Love it? For ${d.offer.days} days after your free wash, a WASHO membership is cheaper: ${pct(d.offer.bp1)} off for 1 wash per week, ${pct(d.offer.bp2)} off for 2, ${pct(d.offer.bp3)} off for 3 or more. It is applied for you at checkout.`);
  return {
    subject: `Your free wash is booked: ${shortDate(d.date)}, ${SLOT_NAME[d.slot].toLowerCase()}`,
    html: layout({
      preheader: `${d.service} on ${shortDate(d.date)}, ${SLOT_NAME[d.slot].toLowerCase()}. Nothing to pay.`,
      heading: 'Your free wash is booked',
      body,
      cta: { label: 'View my booking', url: `${site()}/app/bookings/${d.bookingId}` },
      foot: `Plans changed? Cancel from your booking page and your free wash is given back while ${esc(d.campaign)} is open (claims close ${esc(shortDate(d.claimsCloseOn))}).`,
    }),
  };
}

// ───────────────────────── membership renewal reminder ─────────────────────────
export interface RenewalEmail {
  name: string | null;
  membershipId: string;
  vehicle: string | null;
  plate: string | null;
  endDate: string; // YYYY-MM-DD, the last day of the term
  daysLeft: number;
  washesDone: number;
  washesTotal: number;
  perWeek: number | null;
  months: number;
}

export function renewalEmail(d: RenewalEmail): { subject: string; html: string } {
  const when = d.daysLeft <= 0 ? 'today' : d.daysLeft === 1 ? 'tomorrow' : `in ${d.daysLeft} days`;
  const what = [d.perWeek ? `${d.perWeek} wash${d.perWeek > 1 ? 'es' : ''} per week` : null, `${d.months} month${d.months > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
  const car = [d.vehicle, d.plate].filter(Boolean).join(' · ');
  const body =
    p(`Hi ${esc(firstName(d.name))}, your WASHO membership${car ? ` for <strong>${esc(car)}</strong>` : ''} ends <strong>${esc(when)}</strong>, on ${esc(longDate(d.endDate))}.`) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 14px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0">` +
    row('Your plan', esc(what)) +
    row('Washes done', `${d.washesDone} of ${d.washesTotal}`) +
    row('Ends', esc(longDate(d.endDate))) +
    `</table>` +
    p('To keep your vehicle shining without a gap, renew now. We have filled in your current plan: your days, your time and your vehicle. Change anything you like, then pay. Your new plan starts the day after this one ends.') +
    p('Memberships of 3, 6 or 12 months get a bigger discount than a single month.');
  return {
    subject: `Your WASHO membership ends ${when}: renew in one tap`,
    html: layout({
      preheader: `Ends ${shortDate(d.endDate)}. Renew with your plan already filled in.`,
      heading: 'Time to renew your membership',
      body,
      cta: { label: 'Renew my membership', url: `${site()}/app/membership/new?renew=${d.membershipId}` },
      foot: 'Nothing renews on its own and nothing is charged unless you choose to pay. If you do not want to continue, you do not need to do anything.',
    }),
  };
}

// ───────────────────────── admin sign-in code ─────────────────────────
/**
 * The second step of an ADMIN's sign-in (after their password): the code, big, to copy and paste. Sent straight away and never logged or retried.
 * Customers never get one: they sign in with their mobile number (an SMS code) or an email and password.
 */
export function adminSignInCodeEmail(code: string): { subject: string; html: string } {
  const group = code.length % 4 === 0 ? 4 : 3; // 8 digits read as 4 + 4, 6 as 3 + 3
  const spaced = code.replace(new RegExp(`(\\d{${group}})(?=\\d)`, 'g'), '$1 ').trim();
  const body =
    p('Someone just entered your WASHO admin password. To finish signing in, copy this code and paste it into the sign-in page.') +
    `<p style="margin:18px 0 20px;text-align:center"><span style="display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:14px 22px;font-size:34px;font-weight:800;letter-spacing:6px;color:#0f172a;font-family:'SFMono-Regular',Menlo,Consolas,monospace">${esc(code)}</span></p>` +
    p('The code works for a short while and only once.');
  return {
    subject: `${spaced} is your WASHO admin sign-in code`,
    html: layout({
      preheader: `Your WASHO admin sign-in code is ${spaced}.`,
      heading: 'Your admin sign-in code',
      body,
      foot: 'If this was not you, do not share the code, and change your password as soon as you can: someone has your password.',
    }),
  };
}

// ───────────────────────── sending each one once ─────────────────────────
export type SendResult = 'sent' | 'already' | 'failed';

const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');

/**
 * Takes the right to send (the database says no if this email was already sent or is being sent), sends it, and records the result.
 * A failure is recorded and tried again on a later run, up to three times. On a database without migration 18 the email is still sent
 * (just not remembered): only the free-wash confirmation uses that, and it is sent once per claim anyway.
 */
export async function sendTracked(kind: string, ref: string, to: string, build: () => { subject: string; html: string }, o: { requireLog?: boolean } = {}): Promise<SendResult> {
  let logId: string | null = null;
  try {
    logId = await withApiRole(async (c) => (await c.query('SELECT public.svc_claim_email($1, $2, $3) AS id', [kind, ref, to])).rows[0].id as string | null);
    if (!logId) return 'already';
  } catch (err) {
    if (!campaignsNotInstalled(err) || o.requireLog) throw err;
  }
  const finish = (ok: boolean, error?: string) =>
    logId ? withApiRole((c) => c.query('SELECT public.svc_finish_email($1, $2, $3)', [logId, ok, error ?? null])).catch((e) => console.error('Could not record the email result:', e.message)) : Promise.resolve();
  try {
    const { subject, html } = build();
    await sendMail({ to, subject, html });
    await finish(true);
    return 'sent';
  } catch (err) {
    const message = (err as Error).message;
    console.error(`Email "${kind}" to ${maskEmail(to)} failed: ${message}`);
    await finish(false, message);
    return 'failed';
  }
}
