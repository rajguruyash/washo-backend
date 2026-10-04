import { ImageOff } from 'lucide-react';
import { usePhotos } from '../lib/queries';
import type { Photo } from '../lib/types';
import { Skeleton } from './ui/Skeleton';

const typeLabel: Record<Photo['photo_type'], string> = { front: 'Front', rear: 'Rear', left: 'Left', right: 'Right', additional: 'Extra' };

/** Before / after photos. The links are short-lived signed URLs issued only to the customer, the holding specialist and admins. */
export function PhotoGrid({ bookingId, enabled = true }: { bookingId: string; enabled?: boolean }) {
  const { data, isLoading } = usePhotos(bookingId, enabled);
  if (isLoading) return <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-square" />)}</div>;
  if (!data?.length) return null;
  return (
    <div className="space-y-5">
      {(['before', 'after'] as const).map((phase) => {
        const items = data.filter((p) => p.phase === phase);
        if (!items.length) return null;
        return (
          <div key={phase}>
            <p className="eyebrow mb-2">{phase === 'before' ? 'Before' : 'After'}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {items.map((p) => (
                <a key={p.id} href={p.url ?? undefined} target="_blank" rel="noreferrer" className="group relative block aspect-square overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]">
                  {p.url ? <img src={p.url} alt={`${phase} photo, ${typeLabel[p.photo_type]}`} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" /> : <span className="grid h-full place-items-center text-fog"><ImageOff className="h-6 w-6" /></span>}
                  <span className="absolute bottom-1.5 left-1.5 rounded-full bg-ink-950/75 px-2 py-0.5 text-[10px] font-semibold">{typeLabel[p.photo_type]}</span>
                </a>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
