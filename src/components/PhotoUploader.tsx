import { useQueryClient } from '@tanstack/react-query';
import { Camera, Check, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { compressImage } from '../lib/image';
import { keys, uploadWashPhoto, usePhotos } from '../lib/queries';
import type { Photo } from '../lib/types';
import { useToast } from './ui/Toast';

const ANGLES: { id: Photo['photo_type']; label: string }[] = [
  { id: 'front', label: 'Front' },
  { id: 'rear', label: 'Rear' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
];

/** Camera tiles for one phase (before / after). One photo is required to continue; four angles are encouraged. */
export function PhotoUploader({ bookingId, phase, disabled }: { bookingId: string; phase: 'before' | 'after'; disabled?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: photos } = usePhotos(bookingId);
  const [busy, setBusy] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const mine = (photos ?? []).filter((p) => p.phase === phase);

  const pick = async (type: Photo['photo_type'], file?: File | null) => {
    if (!file) return;
    setBusy(type);
    try {
      await uploadWashPhoto(bookingId, phase, type, await compressImage(file));
      await qc.invalidateQueries({ queryKey: keys.photos(bookingId) });
      await qc.invalidateQueries({ queryKey: keys.workerQueue });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The photo could not be saved.');
    } finally {
      setBusy(null);
      const el = inputs.current[type];
      if (el) el.value = '';
    }
  };

  const tile = (id: Photo['photo_type'], label: string) => {
    const done = mine.find((p) => p.photo_type === id);
    return (
      <label key={id} className={cn('relative grid aspect-square cursor-pointer place-items-center overflow-hidden rounded-2xl border text-center transition-colors', done ? 'border-ok/40 bg-ok/10' : 'border-dashed border-white/20 bg-white/[0.03] hover:border-washo-400/60', (disabled || busy) && 'pointer-events-none opacity-60')}>
        <input ref={(el) => { inputs.current[id] = el; }} type="file" accept="image/*" capture="environment" className="sr-only" disabled={disabled || Boolean(busy)} onChange={(e) => void pick(id, e.target.files?.[0])} aria-label={`${phase} photo, ${label}`} />
        {done?.url && <img src={done.url} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" />}
        <span className="relative flex flex-col items-center gap-1 text-xs font-semibold">
          {busy === id ? <Loader2 className="h-6 w-6 animate-spin" /> : done ? <Check className="h-6 w-6 text-ok" strokeWidth={3} /> : <Camera className="h-6 w-6 text-washo-300" />}
          {label}
        </span>
      </label>
    );
  };

  const extras = mine.filter((p) => p.photo_type === 'additional').length;
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {ANGLES.map((a) => tile(a.id, a.label))}
        {tile('additional', extras ? `Extra (${extras})` : 'Extra')}
      </div>
      <p className="mt-2 text-xs text-fog">{mine.length} photo{mine.length === 1 ? '' : 's'} saved. At least one is needed.</p>
    </div>
  );
}
