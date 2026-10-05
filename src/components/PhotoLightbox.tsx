import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface LightboxPhoto { url: string; label: string }

/**
 * A photo, big, right where the customer is. A cross (or a tap on the dark area, or Esc) puts them back exactly where they were.
 * With several photos: arrows, the arrow keys, or a swipe move between them.
 */
export function PhotoLightbox({ photos, index, onIndex, onClose }: { photos: LightboxPhoto[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const reduce = useReducedMotion();
  const open = index != null && photos[index] != null;
  const closeRef = useRef<HTMLButtonElement>(null);
  const many = photos.length > 1;

  const go = useCallback((delta: number) => {
    if (index == null || photos.length < 2) return;
    onIndex((index + delta + photos.length) % photos.length);
  }, [index, photos.length, onIndex]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    // Captured first, so Esc closes the photo only, not the sheet it was opened from.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'Tab') e.preventDefault(); // focus stays on the viewer's own controls
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, go, onClose]);

  const photo = open ? photos[index!] : null;
  return createPortal(
    <AnimatePresence>
      {photo && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={`Photo: ${photo.label}`}
          className="fixed inset-0 z-[120] flex flex-col bg-ink-950/[0.985] backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          onClick={onClose}
        >
          <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6" onClick={(e) => e.stopPropagation()}>
            <p className="min-w-0 truncate text-sm font-semibold">{photo.label}{many ? <span className="ml-2 font-normal text-fog">{index! + 1} / {photos.length}</span> : null}</p>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close photo" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/15 bg-white/[0.08] text-white transition-colors hover:bg-white/[0.16]">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-6 sm:px-14">
            <motion.img
              key={photo.url}
              src={photo.url}
              alt={photo.label}
              draggable={false}
              className="max-h-full max-w-full select-none rounded-2xl object-contain shadow-2xl"
              initial={{ opacity: 0, scale: reduce ? 1 : 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: reduce ? 0 : 0.2 }}
              drag={many ? 'x' : false}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.35}
              onDragEnd={(_, info) => { if (info.offset.x < -80) go(1); else if (info.offset.x > 80) go(-1); }}
              onClick={(e) => e.stopPropagation()}
            />
            {many && (
              <>
                <button type="button" aria-label="Previous photo" onClick={(e) => { e.stopPropagation(); go(-1); }} className="absolute left-2 top-1/2 hidden h-12 w-12 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-white/[0.08] hover:bg-white/[0.16] sm:grid"><ChevronLeft className="h-6 w-6" /></button>
                <button type="button" aria-label="Next photo" onClick={(e) => { e.stopPropagation(); go(1); }} className="absolute right-2 top-1/2 hidden h-12 w-12 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-white/[0.08] hover:bg-white/[0.16] sm:grid"><ChevronRight className="h-6 w-6" /></button>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
