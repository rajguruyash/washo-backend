import { Eye, EyeOff, KeyRound, ShieldCheck, Wrench } from 'lucide-react';
import { useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, TextArea } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { ApiError, post } from '../../lib/http';
import { rupees } from '../../lib/format';
import { useAdminAction, useAdminSettings } from '../../lib/queries';
import { ConfirmSheet, Loading, errText } from './shared';

function Maintenance({ on, message, canEdit }: { on: boolean; message: string; canEdit: boolean }) {
  const act = useAdminAction();
  const toast = useToast();
  const [text, setText] = useState(message);
  const [confirm, setConfirm] = useState(false);
  const put = (key: string, value: unknown) => act.mutateAsync({ method: 'PUT', path: 'settings', body: { key, value } });
  const saveMessage = async () => { try { await put('maintenance_message', text.trim()); toast.success('Message saved'); } catch (e) { toast.error(errText(e)); } };
  const toggle = async () => {
    try { await put('maintenance_mode', !on); toast.success(on ? 'Booking is open again' : 'Booking is paused'); setConfirm(false); } catch (e) { toast.error(errText(e)); }
  };
  return (
    <section className="glass space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-2xl ${on ? 'bg-warn/15 text-warn' : 'bg-white/[0.06] text-mist'}`}><Wrench className="h-5 w-5" /></span>
          <div>
            <h2 className="text-lg font-bold">Maintenance mode {on ? <Badge tone="amber" className="ml-1 align-middle">On</Badge> : <Badge tone="green" className="ml-1 align-middle">Off</Badge>}</h2>
            <p className="mt-1 max-w-xl text-sm text-fog">While it is on, customers cannot START a new booking, payment or free-wash claim, and see the message below at the top of the site. Everything already under way carries on: payments already made are still recorded, and specialists and admins keep working.</p>
          </div>
        </div>
        {canEdit && <Button variant={on ? 'primary' : 'danger'} onClick={() => (on ? void toggle() : setConfirm(true))} loading={act.isPending && on}>{on ? 'Open booking again' : 'Pause booking'}</Button>}
      </div>
      <TextArea label="What customers see" value={text} maxLength={200} disabled={!canEdit} onChange={(e) => setText(e.target.value)} hint={`${text.length}/200`} />
      {canEdit && <Button variant="glass" disabled={text.trim() === message || text.trim().length < 3} loading={act.isPending && !on} onClick={() => void saveMessage()}>Save message</Button>}
      <ConfirmSheet open={confirm} onClose={() => setConfirm(false)} title="Pause booking?" description="Customers will not be able to book or pay until you open it again." confirmLabel="Pause booking" tone="danger" loading={act.isPending} onConfirm={() => void toggle()} />
    </section>
  );
}

function BigRefunds({ cents, canEdit }: { cents: number; canEdit: boolean }) {
  const act = useAdminAction();
  const toast = useToast();
  const [v, setV] = useState(String(cents / 100));
  const rupeesNow = Number(v);
  const valid = v !== '' && Number.isFinite(rupeesNow) && rupeesNow >= 0 && Math.round(rupeesNow * 100) !== cents;
  const save = async () => {
    try { await act.mutateAsync({ method: 'PUT', path: 'settings', body: { key: 'big_refund_threshold_cents', value: Math.round(rupeesNow * 100) } }); toast.success('Saved'); } catch (e) { toast.error(errText(e)); }
  };
  return (
    <section className="glass space-y-4 p-5">
      <div>
        <h2 className="text-lg font-bold">Big refunds</h2>
        <p className="mt-1 max-w-xl text-sm text-fog">A refund of <strong className="text-white">{rupees(cents)} or more</strong> can only be approved by the super admin, who also has to type the amount back to confirm. Smaller refunds can be approved by anyone with the Finance role. Every refund is written to the activity log.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Input className="w-48" label="Big refund starts at (₹)" inputMode="decimal" value={v} disabled={!canEdit} onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ''))} />
        {canEdit && <Button variant="glass" disabled={!valid} loading={act.isPending} onClick={() => void save()}>Save</Button>}
      </div>
    </section>
  );
}

function ChangePassword() {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setBusy(true);
    try {
      await post('/auth/password', { current_password: cur, new_password: next });
      toast.success('Password changed');
      setCur('');
      setNext('');
    } catch (err) {
      if (err instanceof ApiError) setErrors(Object.keys(err.fields).length ? err.fields : { _: err.message });
      else setErrors({ _: errText(err) });
    } finally { setBusy(false); }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3" noValidate>
      <h3 className="flex items-center gap-2 font-bold"><KeyRound className="h-4 w-4 text-washo-300" /> Change my password</h3>
      <Input label="Current password" type={show ? 'text' : 'password'} autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} error={errors.current_password} />
      <div className="relative">
        <Input label="New password" type={show ? 'text' : 'password'} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} error={errors.new_password} hint="At least 12 characters, with upper and lower case letters and a number." className="[&_input]:pr-12" />
        <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide passwords' : 'Show passwords'} aria-pressed={show} className="absolute right-2 top-[2.05rem] grid h-9 w-9 place-items-center rounded-xl text-fog hover:bg-white/10 hover:text-white">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
      </div>
      {errors._ && <p role="alert" className="text-sm text-bad">{errors._}</p>}
      <Button type="submit" variant="glass" loading={busy} disabled={!cur || !next}>Change password</Button>
    </form>
  );
}

/** App settings (maintenance mode, what counts as a big refund) and how admin sign-in is protected. */
export default function Settings({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, isError, refetch } = useAdminSettings();
  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !data) return <Loading />;
  const { settings, security } = data;
  return (
    <div className="space-y-6">
      <Maintenance key={`${settings.maintenance_mode}|${settings.maintenance_message}`} on={settings.maintenance_mode} message={settings.maintenance_message} canEdit={canEdit} />
      <BigRefunds key={settings.big_refund_threshold_cents} cents={settings.big_refund_threshold_cents} canEdit={canEdit} />
      <section className="glass space-y-5 p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-ok/15 text-ok"><ShieldCheck className="h-5 w-5" /></span>
          <div>
            <h2 className="text-lg font-bold">Admin sign-in security</h2>
            <ul className="mt-2 space-y-1.5 text-sm text-fog">
              <li><strong className="text-white">Two steps.</strong> After the password, a code is emailed to the admin and must be entered. {security.two_step_ready ? <Badge tone="green" className="ml-1">Working</Badge> : <Badge tone="red" className="ml-1">Email is not set up on the server: nobody can sign in as admin</Badge>}</li>
              <li><strong className="text-white">Signed out after {security.idle_minutes} minutes</strong> without activity, and always after 12 hours.</li>
              <li><strong className="text-white">No text-message sign-in for admins.</strong> A SIM swap alone can never open this console.</li>
              <li><strong className="text-white">Strong passwords only:</strong> 12 or more characters, mixed case, a number, nothing guessable. The owner account ({security.super_admin_email}) can never be locked out by a role change.</li>
            </ul>
          </div>
        </div>
        <ChangePassword />
      </section>
    </div>
  );
}
