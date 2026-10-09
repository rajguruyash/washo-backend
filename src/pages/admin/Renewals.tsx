import { CalendarClock, CheckCircle2, MailWarning, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { fullDate, istDay, prettyDate, relativeTime } from '../../lib/format';
import { useAdminAction, useAdminRenewals } from '../../lib/queries';
import type { RenewalSent, RenewalSettings, RenewalStep, RenewalStepStatus, RenewalUpcoming } from '../../lib/types';
import { ConfirmSheet, Loading, Switch, errText } from './shared';

// What each email is called to a person, and how many days either side of the last day the admin may pick (the same limits the database enforces).
const STEPS: { step: RenewalStep; title: string; min: number; max: number }[] = [
  { step: 'week', title: 'Heads-up', min: 1, max: 14 },
  { step: 'last', title: 'Last reminder', min: 0, max: 7 },
  { step: 'ended', title: 'After it ended', min: 1, max: 14 },
];
const KIND_LABEL: Record<string, string> = { membership_renewal_reminder: 'Heads-up', membership_renewal_last_call: 'Last reminder', membership_renewal_ended: 'After it ended' };
const hourLabel = (h: number) => (h === 24 ? 'midnight (end of day)' : h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} am` : `${h - 12} pm`);
const leftLabel = (d: number) => (d > 1 ? `ends in ${d} days` : d === 1 ? 'ends tomorrow' : d === 0 ? 'ends today' : d === -1 ? 'ended yesterday' : `ended ${-d} days ago`);

/** The days a form holds are text while someone types; this says whether they are fine, and what to fix. */
function daysProblem(text: string, min: number, max: number): string | null {
  if (!/^\d{1,2}$/.test(text.trim())) return 'Enter a whole number of days';
  const n = Number(text);
  return n < min || n > max ? `Between ${min} and ${max} days` : null;
}

function SettingsForm({ settings, canEdit, mailReady }: { settings: RenewalSettings; canEdit: boolean; mailReady: boolean }) {
  const act = useAdminAction();
  const toast = useToast();
  const [on, setOn] = useState(settings.on);
  const [step, setStep] = useState({ week: settings.week.on, last: settings.last.on, ended: settings.ended.on });
  const [days, setDays] = useState({ week: String(settings.week.days), last: String(settings.last.days), ended: String(settings.ended.days) });
  const [from, setFrom] = useState(settings.from_hour);
  const [to, setTo] = useState(settings.to_hour);
  const [error, setError] = useState('');

  const problems = Object.fromEntries(STEPS.map((s) => [s.step, daysProblem(days[s.step], s.min, s.max)])) as Record<RenewalStep, string | null>;
  const hoursProblem = from >= to ? 'The sending hours must start before they end' : null;
  const next: RenewalSettings = {
    on,
    week: { on: step.week, days: Number(days.week) }, last: { on: step.last, days: Number(days.last) }, ended: { on: step.ended, days: Number(days.ended) },
    from_hour: from, to_hour: to,
  };
  const sameStep = (a: { on: boolean; days: number }, b: { on: boolean; days: number }) => a.on === b.on && a.days === b.days;
  const changed = next.on !== settings.on || next.from_hour !== settings.from_hour || next.to_hour !== settings.to_hour
    || STEPS.some((s) => !sameStep(next[s.step], settings[s.step]));
  const valid = !hoursProblem && STEPS.every((s) => !problems[s.step]);
  const undo = () => {
    setOn(settings.on);
    setStep({ week: settings.week.on, last: settings.last.on, ended: settings.ended.on });
    setDays({ week: String(settings.week.days), last: String(settings.last.days), ended: String(settings.ended.days) });
    setFrom(settings.from_hour);
    setTo(settings.to_hour);
    setError('');
  };
  const save = async () => {
    setError('');
    try { await act.mutateAsync({ method: 'PUT', path: 'renewals/settings', body: next as unknown as Record<string, unknown> }); toast.success('Renewal email settings saved'); } catch (e) { setError(errText(e)); }
  };
  const sentence: Record<RenewalStep, string> = {
    week: `Sent when the membership has between 1 and ${days.week || '…'} days left.`,
    last: `Sent when it has ${days.last || '…'} days or fewer left (0 is its last day)${step.week ? ', and only if the heads-up went out at least 2 days earlier' : ''}.`,
    ended: `Sent when it ended between 1 and ${days.ended || '…'} days ago and was not renewed.`,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="min-w-0">
          <p className="font-semibold">Send renewal emails automatically</p>
          <p className="text-sm text-fog">{on ? 'The site checks every hour and sends the emails below by itself.' : 'Nothing is sent by itself. You can still send one by hand from the list below, or press "Send reminders now".'}</p>
        </div>
        <Switch on={on} onChange={setOn} label="Send renewal emails automatically" disabled={!canEdit} />
      </div>

      <div className="space-y-3">
        {STEPS.map((s) => (
          <div key={s.step} className={`flex flex-wrap items-start gap-x-4 gap-y-3 rounded-2xl border border-white/10 p-4 ${step[s.step] ? 'bg-white/[0.03]' : 'bg-white/[0.01] opacity-80'}`}>
            <Switch on={step[s.step]} onChange={(v) => setStep((x) => ({ ...x, [s.step]: v }))} label={`${s.title} email`} disabled={!canEdit} />
            <div className="min-w-0 flex-1 basis-56">
              <p className="font-semibold">{s.title} {!step[s.step] && <Badge tone="slate" className="ml-1 align-middle">Off</Badge>}</p>
              <p className="text-sm text-fog">{step[s.step] ? sentence[s.step] : 'Switched off: this email is never sent, not even by hand.'}</p>
            </div>
            <Input
              className="w-36" label={s.step === 'ended' ? 'Days after' : 'Days before'} inputMode="numeric" value={days[s.step]} disabled={!canEdit || !step[s.step]}
              onChange={(e) => setDays((d) => ({ ...d, [s.step]: e.target.value.replace(/\D/g, '').slice(0, 2) }))} error={step[s.step] ? (problems[s.step] ?? undefined) : undefined}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <Select className="w-44" label="Send from (Pune time)" value={from} disabled={!canEdit} onChange={(e) => setFrom(Number(e.target.value))}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
        </Select>
        <Select className="w-52" label="Until" value={to} disabled={!canEdit} onChange={(e) => setTo(Number(e.target.value))} error={hoursProblem ?? undefined}>
          {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
        </Select>
        <p className="max-w-sm pt-7 text-xs text-fog">Only the automatic check keeps to these hours, so nobody gets an email at 3 am. The "Send" buttons on this page ignore them.</p>
      </div>

      {!mailReady && <p role="alert" className="flex items-start gap-2 rounded-2xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn"><MailWarning className="mt-0.5 h-4 w-4 shrink-0" /> Email is not set up on the server (the Resend key is missing), so nothing can be sent yet.</p>}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={!changed || !valid} loading={act.isPending} onClick={() => void save()}>Save settings</Button>
          {changed && <Button variant="glass" disabled={act.isPending} onClick={undo}>Undo changes</Button>}
        </div>
      )}
    </div>
  );
}

type Tone = 'green' | 'amber' | 'red' | 'slate';
const chipTone: Record<RenewalStepStatus['status'], Tone> = { sent: 'green', sending: 'amber', failed: 'red', skipped: 'slate' };
const toneClass: Record<Tone, string> = {
  green: 'border-ok/30 bg-ok/10 text-ok',
  red: 'border-bad/30 bg-bad/10 text-bad',
  amber: 'border-warn/30 bg-warn/10 text-warn',
  slate: 'border-white/10 bg-white/[0.04] text-mist',
};
function stepChip(s: RenewalStepStatus | null, on: boolean): { text: string; tone: Tone; title?: string; sendable: boolean } {
  if (!on) return { text: 'Off', tone: 'slate', sendable: false };
  if (!s) return { text: 'Not sent', tone: 'slate', sendable: true };
  if (s.status === 'sent') return { text: `Sent ${prettyDate(istDay(s.at))}`, tone: 'green', title: 'Already sent', sendable: false };
  if (s.status === 'skipped') return { text: 'Skipped', tone: 'slate', sendable: false };
  if (s.status === 'sending') return { text: 'Sending…', tone: 'amber', sendable: false };
  return { text: s.attempts >= 3 ? 'Failed, gave up' : 'Failed, will retry', tone: 'red', title: s.error ?? undefined, sendable: true };
}

function ComingUp({ rows, settings, canEdit, mailReady }: { rows: RenewalUpcoming[]; settings: RenewalSettings; canEdit: boolean; mailReady: boolean }) {
  const act = useAdminAction();
  const toast = useToast();
  const [ask, setAsk] = useState<{ row: RenewalUpcoming; step: RenewalStep } | null>(null);
  const send = async () => {
    if (!ask) return;
    try {
      await act.mutateAsync({ path: `renewals/${ask.row.membership_id}/send`, body: { step: ask.step } });
      toast.success(`Email sent to ${ask.row.customer_name ?? 'the customer'}`);
    } catch (e) { toast.error(errText(e)); }
    setAsk(null);
  };
  if (!rows.length) return <p className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-center text-sm text-fog">No membership ends in the next 14 days, and none ended in the last 7.</p>;
  return (
    <>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.membership_id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
              <div className="min-w-0">
                <p className="truncate font-semibold">{r.customer_name ?? 'Customer'} <span className="font-normal text-fog">· {[r.vehicle_model, r.registration_number].filter(Boolean).join(' ')}</span></p>
                <p className="truncate text-xs text-fog">{r.reference_code ? `${r.reference_code} · ` : ''}{r.email ?? <span className="text-warn">No email address: nothing can be sent</span>}</p>
              </div>
              <div className="flex items-center gap-2 text-sm">
                {r.renewed && <Badge tone="green" icon={<CheckCircle2 className="h-3 w-3" />}>Renewed</Badge>}
                <span className={r.days_left < 0 ? 'text-fog' : r.days_left <= 2 ? 'font-semibold text-warn' : 'text-mist'}>{leftLabel(r.days_left)} · {fullDate(r.end_date)}</span>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {STEPS.map((s) => {
                const chip = stepChip(r.steps[s.step], settings[s.step].on);
                const canSend = canEdit && mailReady && chip.sendable && Boolean(r.email);
                const body = (<><span className="text-fog">{s.title}:</span> <span className="font-semibold">{chip.text}</span></>);
                return canSend ? (
                  <button
                    key={s.step} type="button" title={chip.title} aria-label={`${s.title}: ${chip.text}. Send it now to ${r.customer_name ?? 'the customer'}`} onClick={() => setAsk({ row: r, step: s.step })}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors hover:border-washo-400/50 hover:bg-washo-400/10 ${toneClass[chip.tone]}`}
                  >
                    {body} <Send className="h-3 w-3 text-washo-300" aria-hidden />
                  </button>
                ) : (
                  <span key={s.step} title={chip.title} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${toneClass[chip.tone]}`}>{body}</span>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      <ConfirmSheet
        open={Boolean(ask)} onClose={() => setAsk(null)} title="Send this email now?" confirmLabel="Send email" loading={act.isPending}
        description={ask ? `The "${STEPS.find((s) => s.step === ask.step)?.title}" email goes to ${ask.row.customer_name ?? 'the customer'} (${ask.row.email}) right away, whatever the dates. They only ever get each email once.` : undefined}
        onConfirm={() => void send()}
      />
    </>
  );
}

function Recent({ rows }: { rows: RenewalSent[] }) {
  if (!rows.length) return <p className="text-sm text-fog">No renewal email has been sent yet.</p>;
  return (
    <ul className="divide-y divide-white/5 rounded-2xl border border-white/10 bg-white/[0.03]">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="truncate"><span className="font-semibold">{KIND_LABEL[r.kind] ?? r.kind}</span> <span className="text-fog">· {r.customer_name ?? 'Customer'} · {r.to_email}</span></p>
            {r.error && r.status !== 'sent' && <p className="truncate text-xs text-bad">{r.error}</p>}
          </div>
          <div className="flex items-center gap-2 text-xs text-fog">
            <Badge tone={chipTone[r.status]}>{r.status === 'sent' ? 'Sent' : r.status === 'failed' ? `Failed (${r.attempts})` : r.status === 'sending' ? 'Sending' : 'Skipped'}</Badge>
            <span>{relativeTime(r.at)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The renewal emails, in the Memberships tab: switch them on or off, how many days, the hours; who is coming up; what went out. */
export default function Renewals({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, isError, refetch } = useAdminRenewals();
  const act = useAdminAction();
  const toast = useToast();
  const [showRecent, setShowRecent] = useState(false);
  const key = useMemo(() => JSON.stringify(data?.settings ?? null), [data?.settings]);

  // "Who needs one?" and "Send reminders now": the same job the site runs by itself, started by hand (it ignores the master switch and the hours, never the steps).
  const run = async (dry: boolean) => {
    try {
      const r = (await act.mutateAsync({ path: `reminders/run${dry ? '?dry=1' : ''}`, body: {} })) as { ready: boolean; due: number; sent: number; already: number; failed: number; stages?: { stage: RenewalStep; due: number; sent: number }[] };
      const names = { week: 'heads-up', last: 'last reminder', ended: 'after it ended' } as const;
      const split = (k: 'due' | 'sent') => (r.stages ?? []).filter((s) => s[k] > 0).map((s) => `${s[k]} ${names[s.stage]}`).join(', ');
      if (!r.ready) toast.error('Renewal emails are not set up yet: the email key or the latest database update is missing.');
      else if (dry) toast.success(r.due ? `${r.due} renewal email${r.due > 1 ? 's are' : ' is'} due (${split('due')}).` : 'Nobody needs a renewal email right now.');
      else toast.success(r.due ? `Renewal emails: ${r.sent} sent${split('sent') ? ` (${split('sent')})` : ''}${r.failed ? `, ${r.failed} failed` : ''}${r.already ? `, ${r.already} already sent` : ''}.` : 'Nobody needs a renewal email right now.');
    } catch (e) { toast.error(errText(e)); }
  };

  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !data) return <Loading />;
  return (
    <section className="glass mb-8 space-y-6 p-5" aria-labelledby="renewals-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-washo-400/15 text-washo-300"><CalendarClock className="h-5 w-5" /></span>
          <div>
            <h2 id="renewals-title" className="text-lg font-bold">Renewal emails {data.settings.on ? <Badge tone="green" className="ml-1 align-middle">Automatic</Badge> : <Badge tone="amber" className="ml-1 align-middle">Automatic sending is off</Badge>}</h2>
            <p className="mt-1 max-w-xl text-sm text-fog">Customers whose membership is about to end get up to three emails with their plan filled in and a button that renews it. Each goes out once, never to someone who has already renewed, never two in one day. The customer's own page shows a Renew card too.</p>
          </div>
        </div>
        {canEdit && <div className="flex gap-2"><Button size="sm" variant="glass" loading={act.isPending} onClick={() => void run(true)}>Who needs one?</Button><Button size="sm" loading={act.isPending} onClick={() => void run(false)}>Send reminders now</Button></div>}
      </div>
      <SettingsForm key={key} settings={data.settings} canEdit={canEdit} mailReady={data.mail_ready} />
      <div>
        <h3 className="mb-3 font-bold">Coming up</h3>
        <ComingUp rows={data.upcoming} settings={data.settings} canEdit={canEdit} mailReady={data.mail_ready} />
      </div>
      <div>
        <button type="button" onClick={() => setShowRecent((s) => !s)} aria-expanded={showRecent} className="mb-3 text-sm font-semibold text-washo-300">{showRecent ? 'Hide' : 'Show'} the latest emails sent ({data.recent.length})</button>
        {showRecent && <Recent rows={data.recent} />}
      </div>
    </section>
  );
}
