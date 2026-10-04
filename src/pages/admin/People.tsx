import { Archive, ArchiveRestore, CalendarPlus, KeyRound, Pencil, Phone, Plus, Search, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { VehicleToggle } from '../../components/VehicleToggle';
import { ErrorState } from '../../components/EmptyState';
import { formatPlate, prettyDate, prettyPhone, rupees, vehicleLabel } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useAdminAction, useAdminCustomer, useAdminCustomers, useAdminWorkers } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { staffStatus } from '../../lib/status';
import type { AdminAddress, AdminVehicle, Specialist, VehicleType } from '../../lib/types';
import { ConfirmSheet, Loading, errText } from './shared';

type Scope = 'active' | 'archived';
const scopeOptions: { value: Scope; label: string }[] = [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }];

// ───────────────────────── specialists ─────────────────────────
function AddSpecialist({ open, onClose }: { open: boolean; onClose: () => void }) {
  const act = useAdminAction();
  const toast = useToast();
  const [f, setF] = useState({ full_name: '', email: '', phone: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    try {
      await act.mutateAsync({ path: 'workers', body: f });
      toast.success('Specialist created. Share their email and password with them.');
      setF({ full_name: '', email: '', phone: '', password: '' });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields); else toast.error(errText(err));
    }
  };
  return (
    <Sheet open={open} onClose={onClose} size="sm" title="Add a specialist" description="They sign in at /login with this email and password." footer={<Button type="submit" form="worker-form" full size="lg" loading={act.isPending}>Create specialist</Button>}>
      <form id="worker-form" onSubmit={submit} className="space-y-4" noValidate>
        <Input label="Full name" value={f.full_name} error={errors.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} required />
        <Input label="Email" type="email" value={f.email} error={errors.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        <Input label="Phone" value={f.phone} error={errors.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required />
        <Input label="Temporary password" type="text" value={f.password} error={errors.password} onChange={(e) => setF({ ...f, password: e.target.value })} hint="At least 8 characters." required />
      </form>
    </Sheet>
  );
}

function SpecialistSheet({ worker, onClose }: { worker: Specialist | null; onClose: () => void }) {
  const act = useAdminAction();
  const toast = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pw, setPw] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setName(worker?.full_name ?? ''); setPhone(worker?.phone ?? ''); setPw(''); setErrors({}); }, [worker]);
  if (!worker) return <Sheet open={false} onClose={onClose}><span /></Sheet>;
  const archived = Boolean(worker.archived);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    try { await act.mutateAsync({ method: 'PUT', path: `workers/${worker.id}`, body: { full_name: name, phone } }); toast.success('Saved'); onClose(); }
    catch (err) { if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields); else toast.error(errText(err)); }
  };
  const setArchived = async (value: boolean) => {
    try {
      const r = await act.mutateAsync({ path: `workers/${worker.id}/archive`, body: { archived: value } });
      toast.success(value ? `Archived. ${r.released_washes ?? 0} upcoming wash(es) and ${r.released_memberships ?? 0} membership(s) went back to the pool.` : 'Restored. They can sign in again.');
      setConfirm(false);
      onClose();
    } catch (err) { toast.error(errText(err)); setConfirm(false); }
  };
  const reset = async () => {
    try { await act.mutateAsync({ path: `workers/${worker.id}/reset-password`, body: { password: pw } }); toast.success('New password set. Share it with them.'); setPw(''); }
    catch (err) { toast.error(errText(err)); }
  };

  return (
    <>
      <Sheet open onClose={onClose} size="sm" title={worker.full_name ?? 'Specialist'} description={archived ? 'Archived: cannot sign in or be given washes.' : `${worker.washes_next_7_days} wash${worker.washes_next_7_days === 1 ? '' : 'es'} in the next 7 days`}>
        <div className="space-y-6">
          {!archived && (
            <form onSubmit={save} className="space-y-4" noValidate>
              <Input label="Full name" value={name} error={errors.full_name} onChange={(e) => setName(e.target.value)} required />
              <Input label="Phone" value={phone} error={errors.phone} onChange={(e) => setPhone(e.target.value)} required />
              <Button type="submit" full loading={act.isPending}>Save changes</Button>
            </form>
          )}
          {!archived && (
            <section className="space-y-3 border-t border-white/10 pt-5">
              <h3 className="flex items-center gap-2 text-sm font-bold"><KeyRound className="h-4 w-4 text-washo-300" /> Set a new password</h3>
              <Input label="New password" type="text" value={pw} onChange={(e) => setPw(e.target.value)} hint="At least 8 characters. Tell them in person." />
              <Button variant="glass" full disabled={pw.length < 8} loading={act.isPending} onClick={() => void reset()}>Set password</Button>
            </section>
          )}
          <section className="space-y-3 border-t border-white/10 pt-5">
            {archived ? (
              <Button full icon={<ArchiveRestore className="h-4 w-4" />} loading={act.isPending} onClick={() => void setArchived(false)}>Restore specialist</Button>
            ) : (
              <>
                <Button variant="danger" full icon={<Archive className="h-4 w-4" />} onClick={() => setConfirm(true)}>Archive specialist</Button>
                <p className="text-xs text-fog">Archiving never deletes anything. Their wash history stays, and you can restore them any time.</p>
              </>
            )}
          </section>
        </div>
      </Sheet>
      <ConfirmSheet open={confirm} onClose={() => setConfirm(false)} loading={act.isPending} tone="danger" confirmLabel="Archive" title={`Archive ${worker.full_name ?? 'this specialist'}?`}
        description="Their upcoming washes and memberships go back to the pool, and they can no longer sign in. A wash they are in the middle of must be finished first." onConfirm={() => void setArchived(true)} />
    </>
  );
}

// ───────────────────────── customers ─────────────────────────
function AddCustomer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const act = useAdminAction();
  const toast = useToast();
  const [f, setF] = useState({ full_name: '', phone: '', email: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    try {
      await act.mutateAsync({ path: 'customers', body: { ...f, phone: f.phone.replace(/\D/g, '') } });
      toast.success('Customer added. They sign in with that number; their details are already waiting.');
      setF({ full_name: '', phone: '', email: '' });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields); else toast.error(errText(err));
    }
  };
  return (
    <Sheet open={open} onClose={onClose} size="sm" title="Add a customer" description="Register someone who has not signed up yet. Double-check the number: whoever has it can sign in to this account." footer={<Button type="submit" form="customer-form" full size="lg" loading={act.isPending}>Add customer</Button>}>
      <form id="customer-form" onSubmit={submit} className="space-y-4" noValidate>
        <Input label="Full name" value={f.full_name} error={errors.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} required />
        <Input label="Mobile number" inputMode="numeric" placeholder="98765 43210" value={f.phone} error={errors.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required />
        <Input label="Email" type="email" value={f.email} error={errors.email} onChange={(e) => setF({ ...f, email: e.target.value })} optional />
      </form>
    </Sheet>
  );
}

function VehicleForm({ customerId, vehicle, addresses, onDone }: { customerId: string; vehicle?: AdminVehicle; addresses: AdminAddress[]; onDone: () => void }) {
  const act = useAdminAction();
  const toast = useToast();
  const [type, setType] = useState<VehicleType>(vehicle?.vehicle_type ?? 'car');
  const [f, setF] = useState({ make: vehicle?.make ?? '', model: vehicle?.model ?? '', registration_number: vehicle?.registration_number ?? '', color: vehicle?.color ?? '', address_id: vehicle?.address_id ?? '', parking_location: vehicle?.parking_location ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    const body = { vehicle_type: type, ...f, address_id: f.address_id || null };
    try {
      await act.mutateAsync(vehicle ? { method: 'PUT', path: `vehicles/${vehicle.id}`, body } : { path: `customers/${customerId}/vehicles`, body });
      toast.success(vehicle ? 'Vehicle saved' : 'Vehicle added');
      onDone();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields); else toast.error(errText(err));
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div><p className="mb-1.5 text-[13px] font-medium text-mist">Vehicle type</p><VehicleToggle value={type} onChange={setType} className="w-full" /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Make" optional value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} />
        <Input label="Model" value={f.model} error={errors.model} onChange={(e) => setF({ ...f, model: e.target.value })} required />
        <Input label="Registration number" value={f.registration_number} error={errors.registration_number} onChange={(e) => setF({ ...f, registration_number: e.target.value })} required />
        <Input label="Colour" optional value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} />
      </div>
      <Select label="Usual address" optional value={f.address_id} onChange={(e) => setF({ ...f, address_id: e.target.value })}>
        <option value="">None</option>
        {addresses.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.label} · {a.society_name}, {a.flat_number}</option>)}
      </Select>
      <Input label="Parking spot" optional value={f.parking_location} onChange={(e) => setF({ ...f, parking_location: e.target.value })} />
      <div className="grid grid-cols-2 gap-3"><Button variant="glass" type="button" onClick={onDone}>Back</Button><Button type="submit" loading={act.isPending}>{vehicle ? 'Save vehicle' : 'Add vehicle'}</Button></div>
    </form>
  );
}

function AddressForm({ customerId, address, onDone }: { customerId: string; address?: AdminAddress; onDone: () => void }) {
  const act = useAdminAction();
  const toast = useToast();
  const [f, setF] = useState({
    label: address?.label ?? 'Home', society_name: address?.society_name ?? '', building_block: address?.building_block ?? '', flat_number: address?.flat_number ?? '',
    parking_location: address?.parking_location ?? '', area_locality: address?.area_locality ?? 'Kharadi', city: address?.city ?? 'Pune', pincode: address?.pincode ?? '411014',
  });
  const [isDefault, setIsDefault] = useState(address?.is_default ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    const body = { ...f, is_default: isDefault };
    try {
      await act.mutateAsync(address ? { method: 'PUT', path: `addresses/${address.id}`, body } : { path: `customers/${customerId}/addresses`, body });
      toast.success(address ? 'Address saved' : 'Address added');
      onDone();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields); else toast.error(errText(err));
    }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Label" value={f.label} onChange={set('label')} />
        <Input label="Society or building" value={f.society_name} error={errors.society_name} onChange={set('society_name')} required />
        <Input label="Block or wing" value={f.building_block} error={errors.building_block} onChange={set('building_block')} required />
        <Input label="Flat number" value={f.flat_number} error={errors.flat_number} onChange={set('flat_number')} required />
        <Input label="Where it is parked" value={f.parking_location} error={errors.parking_location} onChange={set('parking_location')} required className="sm:col-span-2" />
        <Input label="Area" value={f.area_locality} onChange={set('area_locality')} />
        <Input label="Pincode" inputMode="numeric" value={f.pincode} error={errors.pincode} onChange={set('pincode')} />
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4" /> Make this their main address</label>
      <div className="grid grid-cols-2 gap-3"><Button variant="glass" type="button" onClick={onDone}>Back</Button><Button type="submit" loading={act.isPending}>{address ? 'Save address' : 'Add address'}</Button></div>
    </form>
  );
}

type CustomerView = { kind: 'details' } | { kind: 'edit' } | { kind: 'vehicle'; vehicle?: AdminVehicle } | { kind: 'address'; address?: AdminAddress };

function CustomerSheet({ id, onClose, onBook }: { id: string | null; onClose: () => void; onBook: (customerId: string) => void }) {
  const { data, isLoading, isError, refetch } = useAdminCustomer(id ?? undefined);
  const act = useAdminAction();
  const toast = useToast();
  const [view, setView] = useState<CustomerView>({ kind: 'details' });
  const [confirm, setConfirm] = useState(false);
  const [f, setF] = useState({ full_name: '', email: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { setView({ kind: 'details' }); setConfirm(false); }, [id]);
  useEffect(() => { if (data) { setF({ full_name: data.customer.full_name ?? '', email: data.customer.email ?? '' }); setErrors({}); } }, [data]);
  const c = data?.customer;
  const back = () => setView({ kind: 'details' });

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    try { await act.mutateAsync({ method: 'PUT', path: `customers/${id}`, body: f }); toast.success('Saved'); back(); }
    catch (err) { if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields); else toast.error(errText(err)); }
  };
  const setArchived = async (value: boolean) => {
    try { await act.mutateAsync({ path: `customers/${id}/archive`, body: { archived: value } }); toast.success(value ? 'Archived. They are signed out and cannot sign in.' : 'Restored. They can sign in again.'); setConfirm(false); onClose(); }
    catch (err) { toast.error(errText(err)); setConfirm(false); }
  };
  const flip = async (path: string, body: Record<string, unknown>, ok: string) => {
    try { await act.mutateAsync({ path, body }); toast.success(ok); } catch (err) { toast.error(errText(err)); }
  };

  const title = view.kind === 'vehicle' ? (view.vehicle ? 'Edit vehicle' : 'Add a vehicle') : view.kind === 'address' ? (view.address ? 'Edit address' : 'Add an address') : view.kind === 'edit' ? 'Edit customer' : c?.full_name ?? 'Customer';

  return (
    <>
      <Sheet open={Boolean(id)} onClose={onClose} size="lg" title={title} description={c && view.kind === 'details' ? (c.archived ? 'Archived: cannot sign in.' : `${prettyPhone(c.phone)}${c.email ? ` · ${c.email}` : ''}`) : undefined}>
        {isError ? <ErrorState onRetry={() => void refetch()} /> : isLoading || !data || !c ? <Loading /> : view.kind === 'edit' ? (
          <form onSubmit={saveProfile} className="space-y-4" noValidate>
            <Input label="Full name" value={f.full_name} error={errors.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} required />
            <Input label="Email" type="email" optional value={f.email} error={errors.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            <p className="text-xs text-fog">Their mobile number is how they sign in, so only they can change it (with a code sent to the new number).</p>
            <div className="grid grid-cols-2 gap-3"><Button variant="glass" type="button" onClick={back}>Back</Button><Button type="submit" loading={act.isPending}>Save</Button></div>
          </form>
        ) : view.kind === 'vehicle' ? (
          <VehicleForm customerId={c.id} vehicle={view.vehicle} addresses={data.addresses} onDone={back} />
        ) : view.kind === 'address' ? (
          <AddressForm customerId={c.id} address={view.address} onDone={back} />
        ) : (
          <div className="space-y-7">
            <div className="flex flex-wrap gap-2">
              {!c.archived && <Button size="sm" icon={<CalendarPlus className="h-4 w-4" />} onClick={() => onBook(c.id)}>Book a wash</Button>}
              {!c.archived && <Button size="sm" variant="glass" icon={<Pencil className="h-4 w-4" />} onClick={() => setView({ kind: 'edit' })}>Edit details</Button>}
              {c.phone && <a href={`tel:${c.phone}`} className="inline-flex h-9 items-center gap-1.5 rounded-2xl px-3.5 text-[13px] font-semibold text-mist hover:bg-white/[0.06]"><Phone className="h-4 w-4" /> Call</a>}
            </div>

            <section>
              <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-bold">Vehicles</h3>{!c.archived && <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setView({ kind: 'vehicle' })}>Add</Button>}</div>
              <ul className="space-y-2">
                {data.vehicles.map((v) => (
                  <li key={v.id} className={`panel flex flex-wrap items-center justify-between gap-2 p-3 ${v.is_active ? '' : 'opacity-60'}`}>
                    <div className="text-sm"><p className="font-semibold">{vehicleLabel[v.vehicle_type]} · {v.make ? `${v.make} ` : ''}{v.model}</p><p className="text-xs text-fog">{formatPlate(v.registration_number)}{v.color ? ` · ${v.color}` : ''}{v.is_active ? '' : ' · archived'}</p></div>
                    <div className="flex gap-1">
                      {v.is_active && <Button size="sm" variant="ghost" onClick={() => setView({ kind: 'vehicle', vehicle: v })}>Edit</Button>}
                      <Button size="sm" variant="ghost" onClick={() => void flip(`vehicles/${v.id}/active`, { active: !v.is_active }, v.is_active ? 'Vehicle archived' : 'Vehicle restored')}>{v.is_active ? 'Archive' : 'Restore'}</Button>
                    </div>
                  </li>
                ))}
                {!data.vehicles.length && <li className="panel p-4 text-center text-sm text-fog">No vehicles yet.</li>}
              </ul>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-bold">Addresses</h3>{!c.archived && <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setView({ kind: 'address' })}>Add</Button>}</div>
              <ul className="space-y-2">
                {data.addresses.map((a) => (
                  <li key={a.id} className={`panel flex flex-wrap items-center justify-between gap-2 p-3 ${a.archived ? 'opacity-60' : ''}`}>
                    <div className="text-sm"><p className="font-semibold">{a.label}{a.is_default ? <Badge tone="blue" className="ml-2">Main</Badge> : null}{a.archived ? <Badge className="ml-2">Archived</Badge> : null}</p><p className="text-xs text-fog">{a.society_name}, {a.building_block} {a.flat_number} · {a.parking_location}</p></div>
                    <div className="flex gap-1">
                      {!a.archived && <Button size="sm" variant="ghost" onClick={() => setView({ kind: 'address', address: a })}>Edit</Button>}
                      <Button size="sm" variant="ghost" onClick={() => void flip(`addresses/${a.id}/archived`, { archived: !a.archived }, a.archived ? 'Address restored' : 'Address archived')}>{a.archived ? 'Restore' : 'Archive'}</Button>
                    </div>
                  </li>
                ))}
                {!data.addresses.length && <li className="panel p-4 text-center text-sm text-fog">No addresses yet.</li>}
              </ul>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-bold">Recent washes</h3>
              <ul className="space-y-2">
                {data.washes.map((w) => (
                  <li key={w.id} className="panel flex items-center justify-between gap-3 p-3 text-sm">
                    <div><p className="font-semibold">{w.service_name}</p><p className="text-xs text-fog">{w.reference_code} · {prettyDate(w.scheduled_date)}, {slotLabel(w.time_slot)}{w.price_cents != null ? ` · ${w.price_cents === 0 ? 'Complimentary' : rupees(w.price_cents)}` : ''}</p></div>
                    <Badge tone={staffStatus[w.status].tone}>{staffStatus[w.status].label}</Badge>
                  </li>
                ))}
                {!data.washes.length && <li className="panel p-4 text-center text-sm text-fog">No washes yet.</li>}
              </ul>
            </section>

            <section className="space-y-3 border-t border-white/10 pt-5">
              {c.archived ? (
                <Button full icon={<ArchiveRestore className="h-4 w-4" />} loading={act.isPending} onClick={() => void setArchived(false)}>Restore customer</Button>
              ) : (
                <>
                  <Button variant="danger" full icon={<Archive className="h-4 w-4" />} onClick={() => setConfirm(true)}>Archive customer</Button>
                  <p className="text-xs text-fog">Archiving never deletes anything: their washes, payments and refunds stay on record, and you can restore them. A customer with scheduled washes or an active membership has to have those cancelled first.</p>
                </>
              )}
            </section>
          </div>
        )}
      </Sheet>
      <ConfirmSheet open={confirm} onClose={() => setConfirm(false)} loading={act.isPending} tone="danger" confirmLabel="Archive" title={`Archive ${c?.full_name ?? 'this customer'}?`}
        description="They are signed out and can no longer sign in. Their history is kept." onConfirm={() => void setArchived(true)} />
    </>
  );
}

// ───────────────────────── the tab ─────────────────────────
export default function People({ onBook }: { onBook: (customerId: string) => void }) {
  const [scope, setScope] = useState<Scope>('active');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(t); }, [q]);
  const workers = useAdminWorkers(scope);
  const customers = useAdminCustomers(debounced, scope);
  const [addingWorker, setAddingWorker] = useState(false);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [openWorker, setOpenWorker] = useState<Specialist | null>(null);
  const [openCustomer, setOpenCustomer] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <Segmented label="Show" value={scope} onChange={setScope} options={scopeOptions} />
      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <div className="mb-3 flex items-center justify-between"><h2 className="flex items-center gap-2 text-lg font-bold"><Users className="h-5 w-5 text-washo-300" /> Specialists</h2><Button size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAddingWorker(true)}>Add</Button></div>
          {workers.isError ? <ErrorState onRetry={() => void workers.refetch()} /> : (
            <ul className="space-y-2">
              {workers.data?.map((w) => (
                <li key={w.id}>
                  <button onClick={() => setOpenWorker(w)} className="panel flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:border-washo-400/40">
                    <div><p className="font-semibold">{w.full_name}</p><p className="text-sm text-washo-300">{w.phone}</p></div>
                    {w.archived ? <Badge>Archived</Badge> : <Badge tone="blue">{w.washes_next_7_days} this week</Badge>}
                  </button>
                </li>
              ))}
              {workers.data && !workers.data.length && <li className="panel p-6 text-center text-sm text-fog">{scope === 'archived' ? 'No archived specialists.' : 'No specialists yet.'}</li>}
            </ul>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-bold">Customers</h2><Button size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAddingCustomer(true)}>Add</Button></div>
          <div className="relative mb-3"><Search className="pointer-events-none absolute left-4 top-3.5 h-4 w-4 text-fog" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone or email" aria-label="Search customers" className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] pl-11 pr-4 outline-none focus:border-washo-400" /></div>
          {customers.isError ? <ErrorState onRetry={() => void customers.refetch()} /> : (
            <ul className="space-y-2">
              {customers.data?.map((c) => (
                <li key={c.id}>
                  <button onClick={() => setOpenCustomer(c.id)} className="panel w-full p-4 text-left transition-colors hover:border-washo-400/40">
                    <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{c.full_name ?? 'No name yet'}</p><p className="text-sm text-fog"><Phone className="mr-1 inline h-3 w-3" />{prettyPhone(c.phone)}{c.email ? ` · ${c.email}` : ''}</p></div>{c.archived ? <Badge>Archived</Badge> : c.active_memberships > 0 ? <Badge tone="green">Member</Badge> : null}</div>
                    <p className="mt-1 text-xs text-fog">{c.vehicles} vehicle{c.vehicles === 1 ? '' : 's'} · {c.washes} washes{c.signup_source ? ` · via ${c.signup_source}` : ''}</p>
                  </button>
                </li>
              ))}
              {customers.data && !customers.data.length && <li className="panel p-6 text-center text-sm text-fog">{scope === 'archived' ? 'No archived customers.' : 'No customers found.'}</li>}
            </ul>
          )}
        </section>
      </div>

      <AddSpecialist open={addingWorker} onClose={() => setAddingWorker(false)} />
      <AddCustomer open={addingCustomer} onClose={() => setAddingCustomer(false)} />
      <SpecialistSheet worker={openWorker} onClose={() => setOpenWorker(null)} />
      <CustomerSheet id={openCustomer} onClose={() => setOpenCustomer(null)} onBook={(cid) => { setOpenCustomer(null); onBook(cid); }} />
    </div>
  );
}
