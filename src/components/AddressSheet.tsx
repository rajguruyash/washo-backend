import { useEffect, useState } from 'react';
import { ApiError } from '../lib/http';
import { useSaveAddress } from '../lib/queries';
import type { Address } from '../lib/types';
import { Button } from './ui/Button';
import { Input } from './ui/Field';
import { Sheet } from './ui/Sheet';
import { useToast } from './ui/Toast';

export const SOCIETIES = ['Yashwin Orizzonte', 'EON IT Park', 'Magarpatta', 'Kharadi Knowledge Park'];

const blank = { label: 'Home', society_name: '', building_block: '', flat_number: '', parking_location: '' };

/** Add or edit a service address: where the crew finds the vehicle. */
export function AddressSheet({ open, onClose, address, onSaved }: { open: boolean; onClose: () => void; address?: Address | null; onSaved?: (a: Address) => void }) {
  const save = useSaveAddress();
  const toast = useToast();
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (!open) return;
    setF(address ? { label: address.label, society_name: address.society_name, building_block: address.building_block, flat_number: address.flat_number, parking_location: address.parking_location } : blank);
    setErrors({});
    setFormError('');
  }, [open, address]);

  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setErrors((er) => ({ ...er, [k]: '' }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setFormError('');
    try {
      const saved = await save.mutateAsync({ id: address?.id, ...f, area_locality: address?.area_locality ?? 'Kharadi', city: address?.city ?? 'Pune', pincode: address?.pincode ?? '411014' });
      toast.success(address ? 'Address updated' : 'Address saved');
      onSaved?.(saved);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={address ? 'Edit address' : 'Add an address'}
      description="Where our specialist should come."
      size="sm"
      footer={<Button type="submit" form="address-form" full size="lg" loading={save.isPending}>{address ? 'Save changes' : 'Save address'}</Button>}
    >
      <form id="address-form" onSubmit={submit} className="space-y-4" noValidate>
        <Input label="Label" value={f.label} onChange={set('label')} error={errors.label} placeholder="Home, Office…" />
        <div>
          <Input label="Society / building" list="societies" value={f.society_name} onChange={set('society_name')} error={errors.society_name} autoComplete="off" required />
          <datalist id="societies">{SOCIETIES.map((s) => <option key={s} value={s} />)}</datalist>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input label="Block / wing" value={f.building_block} onChange={set('building_block')} error={errors.building_block} placeholder="B" required />
          <Input label="Flat number" value={f.flat_number} onChange={set('flat_number')} error={errors.flat_number} placeholder="B-702" required />
        </div>
        <Input label="Parking location" value={f.parking_location} onChange={set('parking_location')} error={errors.parking_location} placeholder="Basement P1, slot 24" hint="Helps the crew find the vehicle quickly." required />
        {formError && <p role="alert" className="text-sm text-bad">{formError}</p>}
      </form>
    </Sheet>
  );
}

export const addressLine = (a: Address) => `${a.society_name}, ${a.building_block} ${a.flat_number}`;
