import { Bike, Car, CarFront } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { formatPlate } from '../lib/format';
import { ApiError } from '../lib/http';
import { useSaveVehicle } from '../lib/queries';
import type { Vehicle, VehicleType } from '../lib/types';
import { Button } from './ui/Button';
import { Input } from './ui/Field';
import { Sheet } from './ui/Sheet';
import { VehicleToggle } from './VehicleToggle';
import { useToast } from './ui/Toast';

export const vehicleIcon: Record<VehicleType, ReactNode> = {
  bike: <Bike className="h-5 w-5" />,
  car: <Car className="h-5 w-5" />,
  suv: <CarFront className="h-5 w-5" />,
};

export function VehicleSheet({
  open,
  onClose,
  vehicle,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  vehicle?: Vehicle | null;
  onSaved?: (v: Vehicle) => void;
}) {
  const save = useSaveVehicle();
  const toast = useToast();
  const [type, setType] = useState<VehicleType>('car');
  const [model, setModel] = useState('');
  const [reg, setReg] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (!open) return;
    setType(vehicle?.vehicle_type ?? 'car');
    setModel(vehicle?.model ?? '');
    setReg(vehicle ? formatPlate(vehicle.registration_number) : '');
    setErrors({});
    setFormError('');
  }, [open, vehicle]);

  const busy = save.isPending;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setFormError('');
    try {
      const saved = await save.mutateAsync({ id: vehicle?.id, vehicle_type: type, model, registration_number: reg.replace(/\s+/g, ''), make: vehicle?.make ?? undefined, color: vehicle?.color ?? undefined, address_id: vehicle?.address_id });
      toast.success(vehicle ? 'Vehicle updated' : 'Vehicle added');
      onSaved?.(saved);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (Object.keys(err.fields).length) setErrors(err.fields);
        else setFormError(err.message);
      } else setFormError('Something went wrong. Please try again.');
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={vehicle ? 'Edit vehicle' : 'Add a vehicle'}
      description="Save it once and pick it with a tap whenever you book."
      size="sm"
      footer={
        <Button type="submit" form="vehicle-form" full size="lg" loading={busy}>
          {vehicle ? 'Save changes' : 'Add vehicle'}
        </Button>
      }
    >
      <form id="vehicle-form" onSubmit={submit} className="space-y-5">
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-mist">Vehicle type</legend>
          <VehicleToggle value={type} onChange={setType} className="w-full" label="Vehicle type" />
        </fieldset>
        <Input label="Model" placeholder={type === 'bike' ? 'e.g. Activa, Splendor' : 'e.g. Swift, Nexon'} value={model} onChange={(e) => setModel(e.target.value)} error={errors.model} autoComplete="off" required />
        <Input
          label="Registration number"
          placeholder="MH 12 AB 1234"
          value={reg}
          onChange={(e) => setReg(e.target.value.toUpperCase())}
          error={errors.registration_number}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          required
        />
        {formError && <p role="alert" className="text-sm text-bad">{formError}</p>}
      </form>
    </Sheet>
  );
}
