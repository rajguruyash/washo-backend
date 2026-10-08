import { Wrench } from 'lucide-react';
import { usePublicSettings } from '../lib/queries';

/** Shown at the top of the site while maintenance mode is on: new bookings and payments are paused. Nothing is shown otherwise. */
export function MaintenanceNotice({ className = '' }: { className?: string }) {
  const { data } = usePublicSettings();
  if (!data?.maintenance_mode) return null;
  return (
    <div id="maintenance-note" role="status" className={`flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn/10 p-4 text-sm text-warn ${className}`}>
      <Wrench className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p><strong className="font-bold">Booking is paused.</strong> {data.maintenance_message}</p>
    </div>
  );
}
