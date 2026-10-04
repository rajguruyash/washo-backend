import { Bike, Car, CarFront } from 'lucide-react';
import { vehicleLabel } from '../lib/format';
import type { VehicleType } from '../lib/types';
import RubberSegment from './reactbits/RubberSegment';

const ICON: Record<VehicleType, React.ReactNode> = {
  bike: <Bike className="h-4 w-4" aria-hidden />,
  car: <Car className="h-4 w-4" aria-hidden />,
  suv: <CarFront className="h-4 w-4" aria-hidden />,
};

/** Bike / Car / SUV: a rubber thumb that stretches across to the choice (React Bits Rubber Segment). Drag or flick it, or use the arrow keys. */
export function VehicleToggle({ value, onChange, label = 'Vehicle', className }: { value: VehicleType; onChange: (v: VehicleType) => void; label?: string; className?: string }) {
  return (
    <RubberSegment
      aria-label={label}
      className={className}
      items={(['bike', 'car', 'suv'] as VehicleType[]).map((v) => ({ value: v, label: vehicleLabel[v], icon: ICON[v] }))}
      value={value}
      onChange={(v) => onChange(v as VehicleType)}
      size="lg"
      radius={16}
      inset={4}
      trackColor="rgba(255,255,255,0.06)"
      thumbColor="#3f7cff"
      textColor="#c4cde0"
      activeTextColor="#ffffff"
    />
  );
}
