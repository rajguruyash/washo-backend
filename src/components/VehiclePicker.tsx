import { motion } from 'framer-motion';
import { Check, Plus } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { vehicleLabel } from '../lib/format';
import { useVehicles } from '../lib/queries';
import type { Vehicle } from '../lib/types';
import { Plate } from './brand/Plate';
import { Skeleton } from './ui/Skeleton';
import { VehicleSheet, vehicleIcon } from './VehicleSheet';

/** Pick a saved vehicle, or add one without leaving the flow. */
export function VehiclePicker({ value, onChange }: { value: string | null; onChange: (v: Vehicle) => void }) {
  const { data: vehicles, isLoading } = useVehicles();
  const [adding, setAdding] = useState(false);

  if (isLoading) return <div className="grid gap-3 @lg:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>;

  return (
    <div className="@container">
      <div role="radiogroup" aria-label="Choose a vehicle" className="grid gap-3 @lg:grid-cols-2">
        {vehicles?.map((v, i) => {
          const active = v.id === value;
          return (
            <motion.button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(v)}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className={cn(
                'relative flex items-center gap-4 rounded-2xl border p-4 text-left transition-all',
                active ? 'border-washo-400/60 bg-washo-500/10 shadow-[0_0_28px_-8px_rgb(63_124_255/0.65)]' : 'border-white/[0.09] bg-white/[0.03] hover:border-white/20'
              )}
            >
              <span className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-xl', active ? 'bg-washo-500 text-white' : 'bg-white/[0.07] text-washo-300')}>{vehicleIcon[v.vehicle_type]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold">{v.model}</span>
                <span className="mt-1.5 flex items-center gap-2"><Plate reg={v.registration_number} /><span className="text-xs text-fog">{vehicleLabel[v.vehicle_type]}</span></span>
              </span>
              {active && <span className="grid h-6 w-6 place-items-center rounded-full bg-washo-500"><Check className="h-3.5 w-3.5" strokeWidth={3} /></span>}
            </motion.button>
          );
        })}
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex min-h-[88px] items-center justify-center gap-2 rounded-2xl border border-dashed border-white/20 text-sm font-semibold text-mist transition-colors hover:border-washo-400/60 hover:bg-washo-500/5 hover:text-white"
        >
          <Plus className="h-5 w-5" /> Add a vehicle
        </button>
      </div>
      <VehicleSheet open={adding} onClose={() => setAdding(false)} onSaved={onChange} />
    </div>
  );
}
