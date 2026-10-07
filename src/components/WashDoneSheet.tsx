import { CalendarCheck, Camera, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { prettyDate } from '../lib/format';
import { usePhotos } from '../lib/queries';
import { slotLabel, slotWindow } from '../lib/slots';
import type { MembershipWash } from '../lib/types';
import { PhotoGrid } from './PhotoGrid';
import { Badge } from './ui/Badge';
import { Sheet } from './ui/Sheet';

const doneAt = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** One finished wash of a membership, right on the plan page: what was done, when, and the before and after photos (tap one to see it big). */
export function WashDoneSheet({ wash, onClose }: { wash: MembershipWash | null; onClose: () => void }) {
  const photos = usePhotos(wash?.id ?? '', Boolean(wash));
  return (
    <Sheet
      open={Boolean(wash)}
      onClose={onClose}
      size="lg"
      title={wash ? wash.service_name : undefined}
      description={wash ? `${prettyDate(wash.scheduled_date)} · ${slotLabel(wash.time_slot)} (${slotWindow(wash.time_slot)})` : undefined}
      footer={wash && <Link to={`/app/bookings/${wash.id}`} className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-white/15 px-5 py-3 text-sm font-semibold hover:bg-white/10"><ExternalLink className="h-4 w-4" /> Open the full details</Link>}
    >
      {wash && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="green" icon={<CalendarCheck className="h-3.5 w-3.5" />}>Completed{wash.completed_at ? ` · ${doneAt(wash.completed_at)}` : ''}</Badge>
            <span className="text-xs text-fog">{wash.reference_code}</span>
          </div>
          <PhotoGrid bookingId={wash.id} />
          {!photos.isLoading && !photos.data?.length && (
            <p className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-fog"><Camera className="h-4 w-4 shrink-0" /> No photos were saved for this wash.</p>
          )}
        </div>
      )}
    </Sheet>
  );
}
