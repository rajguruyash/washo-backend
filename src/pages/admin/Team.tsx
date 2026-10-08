import { Eye, EyeOff, Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { ROLE_ABOUT, ROLE_LABEL } from '../../lib/adminAccess';
import { ApiError } from '../../lib/http';
import { useAdminAction, useAdminTeam } from '../../lib/queries';
import type { AdminRole, TeamMember } from '../../lib/types';
import { useAuth } from '../../state/auth';
import { ConfirmSheet, Loading, errText } from './shared';

type Given = Exclude<AdminRole, 'super_admin'>;
const GIVEN: Given[] = ['operations', 'finance', 'marketing', 'support'];
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : 'Never');

function AddAdmin({ open, onClose }: { open: boolean; onClose: () => void }) {
  const act = useAdminAction();
  const toast = useToast();
  const [f, setF] = useState({ full_name: '', email: '', password: '', access: 'support' as Given });
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async () => {
    setErrors({});
    try {
      await act.mutateAsync({ path: 'team', body: f });
      toast.success(`${f.full_name} can sign in now. A code is emailed to ${f.email} each time.`);
      setF({ full_name: '', email: '', password: '', access: 'support' });
      onClose();
    } catch (err) {
      setErrors(err instanceof ApiError && Object.keys(err.fields).length ? err.fields : { _: errText(err) });
    }
  };
  return (
    <Sheet open={open} onClose={onClose} locked={act.isPending} size="lg" title="Add an admin" description="They sign in with this email and password, then a code emailed to this address. Use an address they read."
      footer={<Button full size="lg" loading={act.isPending} disabled={!f.full_name.trim() || !f.email.trim() || !f.password} onClick={() => void submit()}>Add admin</Button>}>
      <div className="space-y-4">
        <Input label="Full name" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} error={errors.full_name} autoComplete="off" />
        <Input label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={errors.email} autoComplete="off" />
        <div className="relative">
          <Input label="Password" type={show ? 'text' : 'password'} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} error={errors.password} hint="At least 12 characters, upper and lower case, a number. Tell them in person; they can change it themselves." autoComplete="new-password" className="[&_input]:pr-12" />
          <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} className="absolute right-2 top-[2.05rem] grid h-9 w-9 place-items-center rounded-xl text-fog hover:bg-white/10 hover:text-white">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
        </div>
        <Select label="Role" value={f.access} onChange={(e) => setF({ ...f, access: e.target.value as Given })} error={errors.access}>
          {GIVEN.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </Select>
        <p className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 text-sm"><span className="font-semibold">{ROLE_LABEL[f.access]} can:</span> <span className="text-fog">{ROLE_ABOUT[f.access].can}</span><br /><span className="font-semibold">Cannot:</span> <span className="text-fog">{ROLE_ABOUT[f.access].cannot}</span></p>
        {errors._ && <p role="alert" className="text-sm text-bad">{errors._}</p>}
      </div>
    </Sheet>
  );
}

/** The admins and what each may do. Only the super admin sees this page. */
export default function Team() {
  const { user } = useAuth();
  const { data, isLoading, isError, refetch } = useAdminTeam();
  const act = useAdminAction();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [switching, setSwitching] = useState<TeamMember | null>(null);
  const [changing, setChanging] = useState<{ m: TeamMember; to: Given } | null>(null);

  const doSwitch = async () => {
    if (!switching) return;
    try { await act.mutateAsync({ path: `team/${switching.id}/active`, body: { active: switching.archived } }); toast.success(switching.archived ? 'Switched back on' : 'Switched off and signed out'); setSwitching(null); } catch (e) { toast.error(errText(e)); }
  };
  const doChange = async () => {
    if (!changing) return;
    try { await act.mutateAsync({ method: 'PUT', path: `team/${changing.m.id}/access`, body: { access: changing.to } }); toast.success(`${changing.m.full_name ?? 'They'} is now ${ROLE_LABEL[changing.to]}`); setChanging(null); } catch (e) { toast.error(errText(e)); }
  };

  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !data) return <Loading />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-fog">Everyone who can open this console. Give each person the smallest role that lets them do their job: the role decides which tabs they see and what they can change, and the server checks it on every request. Every change here is written to the activity log.</p>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add an admin</Button>
      </div>
      <ul className="space-y-3">
        {data.map((m) => {
          const owner = m.access === 'super_admin';
          const me = m.id === user?.id;
          return (
            <li key={m.id} className="glass flex flex-wrap items-center gap-x-5 gap-y-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-semibold">{m.full_name ?? m.email}{me && <Badge tone="blue">You</Badge>}{owner && <Badge tone="yellow" icon={<ShieldCheck className="h-3 w-3" />}>Super admin</Badge>}{m.archived && <Badge tone="red">Switched off</Badge>}{!m.access && <Badge tone="red">No role: cannot do anything</Badge>}</p>
                <p className="truncate text-xs text-fog">{m.email} · last signed in {when(m.last_sign_in_at)}</p>
              </div>
              {!owner && !me && (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={`role-${m.id}`}>Role for {m.full_name}</label>
                  <select id={`role-${m.id}`} value={m.access ?? ''} onChange={(e) => e.target.value && setChanging({ m, to: e.target.value as Given })} className="h-10 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm font-semibold">
                    {!m.access && <option value="">Choose a role</option>}
                    {GIVEN.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                  <Button size="sm" variant={m.archived ? 'glass' : 'danger'} onClick={() => setSwitching(m)}>{m.archived ? 'Switch on' : 'Switch off'}</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <section aria-label="What each role can do" className="grid gap-3 md:grid-cols-2">
        {GIVEN.map((r) => (
          <div key={r} className="panel p-4 text-sm">
            <p className="font-bold">{ROLE_LABEL[r]}</p>
            <p className="mt-1 text-fog"><span className="font-semibold text-mist">Can:</span> {ROLE_ABOUT[r].can}</p>
            <p className="mt-1 text-fog"><span className="font-semibold text-mist">Cannot:</span> {ROLE_ABOUT[r].cannot}</p>
          </div>
        ))}
      </section>
      <AddAdmin open={adding} onClose={() => setAdding(false)} />
      <ConfirmSheet open={Boolean(switching)} onClose={() => setSwitching(null)} loading={act.isPending} tone={switching?.archived ? 'primary' : 'danger'}
        title={switching?.archived ? `Switch ${switching.full_name ?? 'this admin'} back on?` : `Switch ${switching?.full_name ?? 'this admin'} off?`}
        description={switching?.archived ? 'They can sign in again with their email, password and emailed code.' : 'They are signed out and cannot sign in until you switch them back on. Nothing they did is removed.'}
        confirmLabel={switching?.archived ? 'Switch on' : 'Switch off'} onConfirm={() => void doSwitch()} />
      <ConfirmSheet open={Boolean(changing)} onClose={() => setChanging(null)} loading={act.isPending}
        title={`Make ${changing?.m.full_name ?? 'them'} ${changing ? ROLE_LABEL[changing.to] : ''}?`} description="It takes effect straight away." confirmLabel="Change role" onConfirm={() => void doChange()}>
        {changing && <p className="text-sm text-fog"><span className="font-semibold text-mist">Can:</span> {ROLE_ABOUT[changing.to].can}<br /><span className="font-semibold text-mist">Cannot:</span> {ROLE_ABOUT[changing.to].cannot}</p>}
      </ConfirmSheet>
    </div>
  );
}
