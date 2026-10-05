import { LocateFixed } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, get } from '../lib/http';
import { useSaveAddress } from '../lib/queries';
import type { Address, GeoPlace } from '../lib/types';
import { Button } from './ui/Button';
import { Input } from './ui/Field';
import { Sheet } from './ui/Sheet';
import { useToast } from './ui/Toast';

export const SOCIETIES = ['Yashwin Orizzonte', 'EON IT Park', 'Magarpatta', 'Kharadi Knowledge Park'];

const blank = { label: 'Home', society_name: '', building_block: '', flat_number: '', parking_location: '' };

/** The known society a looked-up name means ("Yashwin Orizzonte Phase 1" is "Yashwin Orizzonte"), else the name as found. */
const snapSociety = (found: string): string => {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const f = norm(found);
  return SOCIETIES.find((k) => f.includes(norm(k)) || norm(k).includes(f)) ?? found;
};

const geoErrors: Record<number, string> = {
  1: 'Location is blocked for this site. Allow it in your browser settings, or type the address below.',
  2: 'We could not work out where you are. Type the address below.',
  3: 'Finding your location took too long. Try again, or type the address below.',
};

/** Add or edit a service address: where the crew finds the vehicle. */
export function AddressSheet({ open, onClose, address, onSaved }: { open: boolean; onClose: () => void; address?: Address | null; onSaved?: (a: Address) => void }) {
  const save = useSaveAddress();
  const toast = useToast();
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [locating, setLocating] = useState(false);
  const [locNote, setLocNote] = useState('');
  // Where the phone says it is: the area, city and pincode that come with the address when it is saved.
  const [geo, setGeo] = useState<GeoPlace | null>(null);

  useEffect(() => {
    if (!open) return;
    setLocNote('');
    setGeo(null);
    setF(address ? { label: address.label, society_name: address.society_name, building_block: address.building_block, flat_number: address.flat_number, parking_location: address.parking_location } : blank);
    setErrors({});
    setFormError('');
  }, [open, address]);

  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setErrors((er) => ({ ...er, [k]: '' }));
  };

  // "Use my current location": the browser asks permission, we look the coordinates up (once, nothing stored) and fill in the society and area.
  // The block, flat and the exact parking bay are always typed by the customer.
  const locate = () => {
    setLocNote('');
    setFormError('');
    if (!('geolocation' in navigator)) {
      setLocNote('This browser cannot share a location. Type the address below.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { place } = await get<{ place: GeoPlace }>(`/geo/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`);
          setGeo(place);
          if (place.society) {
            setF((x) => ({ ...x, society_name: snapSociety(place.society!) }));
            setErrors((er) => ({ ...er, society_name: '' }));
          }
          const where = [place.area, place.city].filter(Boolean).join(', ');
          setLocNote(
            place.society ? `Found ${snapSociety(place.society)}${where ? `, ${where}` : ''}. Check the name, then add your block, flat and the exact parking bay.`
            : where ? `We found ${where} but not your society. Type its name below, then add your block, flat and parking bay.`
            : 'We could not match that to an address. Type it below.'
          );
          if (place.city && !/pune/i.test(place.city)) setLocNote((n) => `${n} WASHO currently serves Kharadi, Pune.`);
        } catch (err) {
          setLocNote(err instanceof ApiError ? err.message : 'We could not look up your location just now. Type the address below.');
        } finally {
          setLocating(false);
        }
      },
      (err) => {
        setLocating(false);
        setLocNote(geoErrors[err.code] ?? geoErrors[2]);
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 }
    );
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setFormError('');
    try {
      const saved = await save.mutateAsync({
        id: address?.id, ...f,
        area_locality: geo?.area ?? address?.area_locality ?? 'Kharadi',
        city: geo?.city ?? address?.city ?? 'Pune',
        pincode: geo?.pincode ?? address?.pincode ?? '411014',
      });
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
        <div>
          <Button type="button" variant="glass" full icon={<LocateFixed className="h-4 w-4" />} loading={locating} onClick={locate}>Use my current location</Button>
          <p role="status" className={`mt-2 text-xs ${locNote ? 'text-mist' : 'text-fog'}`}>
            {locNote || 'Fills in your society and area. You add the block, flat and exact parking bay. Your location is used once and not stored.'}
          </p>
          {geo && <p className="mt-1 text-[11px] text-fog">Location lookup by OpenStreetMap contributors.</p>}
        </div>
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
