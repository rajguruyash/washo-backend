import { LifeBuoy, LogOut, MapPin, Pencil, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AddressSheet, addressLine } from '../../components/AddressSheet';
import { AvatarHead } from '../../components/brand/Avatar';
import { PhoneEntry } from '../../components/PhoneEntry';
import { PageHeader } from '../../components/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { prettyPhone } from '../../lib/format';
import { ApiError, post } from '../../lib/http';
import { useAddresses, useSaveProfile } from '../../lib/queries';
import type { Address } from '../../lib/types';
import { useAuth } from '../../state/auth';

export default function Account() {
  const { user, logout } = useAuth();
  const save = useSaveProfile();
  const { data: addresses } = useAddresses();
  const toast = useToast();
  const [form, setForm] = useState({ full_name: '', email: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Address | null>(null);
  const [adding, setAdding] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwError, setPwError] = useState<{ field?: 'current' | 'next'; message: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    if (user) setForm({ full_name: user.full_name ?? '', email: user.email ?? '' });
  }, [user]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    try {
      await save.mutateAsync(form);
      toast.success('Profile saved');
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else toast.error(err instanceof ApiError ? err.message : 'Could not save your profile.');
    }
  };

  // The old password is optional: someone who forgot it signs in with a code ("Get a code instead") and sets a new one here within 15 minutes.
  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw.next) return setPwError({ field: 'next', message: 'Choose a new password.' });
    setPwError(null);
    setPwBusy(true);
    try {
      if (pw.current) await post('/auth/password', { current_password: pw.current, new_password: pw.next });
      else await post('/auth/mobile/password', { password: pw.next });
      setPw({ current: '', next: '' });
      toast.success('Password saved');
    } catch (err) {
      if (err instanceof ApiError) setPwError({ field: err.fields.current_password ? 'current' : err.fields.new_password || err.fields.password ? 'next' : undefined, message: err.fields.current_password ?? err.fields.new_password ?? err.fields.password ?? err.message });
      else setPwError({ message: 'Could not save the password. Please try again.' });
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Account" subtitle="Your details, addresses and vehicles." />
      <div className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={submit} className="glass space-y-5 p-6" noValidate>
          <div className="flex items-center gap-4">
            <AvatarHead className="h-16 w-16" />
            <div>
              <p className="text-lg font-bold">{user?.full_name}</p>
              <p className="text-sm text-fog">{user?.phone ? prettyPhone(user.phone) : user?.email}</p>
            </div>
          </div>
          <Input label="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} error={errors.full_name} required />
          <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={errors.email} optional />
          {user?.phone && <Input label="Mobile number" value={prettyPhone(user.phone)} disabled hint="Your sign-in number can't be changed here. Contact WASHO to change it." readOnly />}
          <Button type="submit" loading={save.isPending}>Save changes</Button>
        </form>
        <form onSubmit={(e) => void savePassword(e)} className="glass space-y-4 p-6 lg:col-start-1" noValidate>
          <div>
            <h2 className="text-lg font-bold">Password</h2>
            <p className="mt-1 text-sm text-fog">Change it with your current one. Forgot it? Sign out, choose "Get a code instead" on the sign-in page, then set a new one here (within 15 minutes of signing in with the code).</p>
          </div>
          <Input label="Current password" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => { setPw({ ...pw, current: e.target.value }); setPwError(null); }} error={pwError?.field === 'current' ? pwError.message : undefined} optional />
          <Input label="New password" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => { setPw({ ...pw, next: e.target.value }); setPwError(null); }} error={pwError?.field === 'next' ? pwError.message : undefined} hint="8 or more characters, with letters and a number." />
          {pwError && !pwError.field && <p role="alert" className="rounded-xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">{pwError.message}</p>}
          <Button type="submit" loading={pwBusy}>Save password</Button>
        </form>
        {!user?.phone && <div className="glass p-6 lg:col-start-1"><PhoneEntry compact intro="You signed in with your email. Add a mobile number now, or when you first pay: your specialist rings you before every wash." /></div>}

        <div className="space-y-6">
          <div className="glass p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">Addresses</h2>
              <Button variant="glass" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add</Button>
            </div>
            <ul className="space-y-3">
              {addresses?.map((a) => (
                <li key={a.id} className="panel flex items-start gap-3 p-4">
                  <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-washo-300" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-semibold">{a.label}{a.is_default && <Badge tone="blue">Default</Badge>}</p>
                    <p className="text-sm text-fog">{addressLine(a)}</p>
                    <p className="text-xs text-fog">Parking: {a.parking_location}</p>
                  </div>
                  <button onClick={() => setEditing(a)} aria-label={`Edit ${a.label}`} className="grid h-9 w-9 place-items-center rounded-xl text-fog hover:bg-white/10 hover:text-white"><Pencil className="h-4 w-4" /></button>
                </li>
              ))}
              {addresses && !addresses.length && <li className="text-sm text-fog">No address saved yet.</li>}
            </ul>
          </div>
          <div className="glass flex items-center justify-between p-6">
            <div>
              <h2 className="text-lg font-bold">Vehicles</h2>
              <p className="text-sm text-fog">Manage the vehicles on your account.</p>
            </div>
            <Link to="/app/vehicles" className="text-sm font-semibold text-washo-300 hover:text-white">Open</Link>
          </div>
          <div className="glass flex items-center justify-between p-6">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-bold"><LifeBuoy className="h-5 w-5 text-washo-300" /> Help</h2>
              <p className="text-sm text-fog">Something went wrong? Tell us, and follow our reply.</p>
            </div>
            <Link to="/app/help" className="text-sm font-semibold text-washo-300 hover:text-white">Open</Link>
          </div>
          <Button variant="glass" full icon={<LogOut className="h-4 w-4" />} onClick={() => void logout()}>Sign out</Button>
        </div>
      </div>
      <AddressSheet open={adding} onClose={() => setAdding(false)} />
      <AddressSheet open={Boolean(editing)} address={editing} onClose={() => setEditing(null)} />
    </>
  );
}
