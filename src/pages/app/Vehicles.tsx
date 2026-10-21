import { motion } from 'framer-motion';
import { Palette, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Plate } from '../../components/brand/Plate';
import { EmptyState, ErrorState, PageHeader } from '../../components/EmptyState';
import { Button } from '../../components/ui/Button';
import { Sheet } from '../../components/ui/Sheet';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { VehicleSheet, vehicleIcon } from '../../components/VehicleSheet';
import { missingColour } from '../../lib/colours';
import { vehicleLabel } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useDeleteVehicle, useVehicles } from '../../lib/queries';
import type { Vehicle } from '../../lib/types';
import { ButtonLink } from '../../components/ui/Button';

export default function Vehicles() {
  const { data: vehicles, isLoading, isError, refetch } = useVehicles();
  const del = useDeleteVehicle();
  const toast = useToast();
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [colourOnly, setColourOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Vehicle | null>(null);

  const confirmRemove = async () => {
    if (!removing) return;
    try {
      await del.mutateAsync(removing.id);
      toast.success(`${removing.model} removed`);
      setRemoving(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove this vehicle.');
      setRemoving(null);
    }
  };

  return (
    <>
      <PageHeader title="Vehicles" subtitle="Add your vehicles once, then pick one for a membership or a single wash." action={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add vehicle</Button>} />

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-32" />)}</div>
      ) : vehicles && vehicles.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {vehicles.map((v, i) => (
            <motion.div key={v.id} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }} className="glass flex flex-col gap-5 p-5">
              <div className="flex items-start gap-4">
                <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-washo-500/15 text-washo-300 [&_svg]:h-7 [&_svg]:w-7">{vehicleIcon[v.vehicle_type]}</span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-xl font-bold">{v.model}</h2>
                  <p className="text-sm text-fog">{vehicleLabel[v.vehicle_type]}</p>
                </div>
              </div>
              <Plate reg={v.registration_number} className="self-start scale-110 origin-left" />
              {missingColour(v) ? (
                // The reminder lives here and nowhere else: not on the home page, not in the booking pages.
                <div role="alert" className="flex items-center gap-3 rounded-2xl border border-bad/40 bg-bad/10 p-3 text-sm text-bad">
                  <Palette className="h-4 w-4 shrink-0" aria-hidden />
                  <p className="min-w-0 flex-1 font-medium">Add the colour of this vehicle. It helps our specialist find it.</p>
                  <Button size="sm" variant="glass" onClick={() => { setColourOnly(true); setEditing(v); }}>Add colour</Button>
                </div>
              ) : null}
              <div className="flex gap-2 border-t border-white/[0.07] pt-4">
                <ButtonLink to={`/app/membership/new?vehicle=${v.id}`} size="sm" className="flex-1">Start a membership</ButtonLink>
                <Button variant="glass" size="sm" aria-label={`Edit ${v.model}`} onClick={() => { setColourOnly(false); setEditing(v); }}><Pencil className="h-4 w-4" /></Button>
                <Button variant="glass" size="sm" aria-label={`Remove ${v.model}`} onClick={() => setRemoving(v)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <EmptyState title="No vehicles yet" text="Add a bike or car and you're one tap away from your first wash." action={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add vehicle</Button>} />
      )}

      <VehicleSheet open={adding} onClose={() => setAdding(false)} />
      <VehicleSheet open={Boolean(editing)} vehicle={editing} focusColour={colourOnly} onClose={() => setEditing(null)} />
      <Sheet
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title="Remove this vehicle?"
        description={removing ? `${removing.model} will no longer appear when you book. Past bookings are kept.` : undefined}
        size="sm"
        footer={<div className="grid grid-cols-2 gap-3"><Button variant="glass" onClick={() => setRemoving(null)}>Keep it</Button><Button variant="danger" loading={del.isPending} onClick={confirmRemove}>Remove</Button></div>}
      >
        <p className="text-sm text-fog">A vehicle with an upcoming wash or an active membership can't be removed.</p>
      </Sheet>
    </>
  );
}
