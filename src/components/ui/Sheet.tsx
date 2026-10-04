import { AnimatePresence, motion, useDragControls, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  /** Sticky action area pinned to the bottom (thumb-reachable on phones). */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Block closing by backdrop / Esc / drag, e.g. while a payment is in flight. */
  locked?: boolean;
}

const widths = { sm: 'md:max-w-md', md: 'md:max-w-lg', lg: 'md:max-w-2xl' };

/** Bottom sheet on phones (drag down to dismiss), centred dialog from md up. */
export function Sheet({ open, onClose, title, description, children, footer, size = 'md', locked }: SheetProps) {
  const reduce = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useDragControls();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) onClose();
      if (e.key === 'Tab' && panelRef.current) {
        const f = panelRef.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => panelRef.current?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      clearTimeout(t);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, locked]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center md:items-center md:p-6">
          <motion.div
            className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !locked && onClose()}
          />
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={cn(
              'glass-strong relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-b-none outline-none md:max-h-[88dvh] md:rounded-3xl',
              widths[size]
            )}
            initial={reduce ? { opacity: 0 } : { y: '100%', opacity: 0.6 }}
            animate={reduce ? { opacity: 1 } : { y: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { y: '100%', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            drag={locked ? false : 'y'}
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 600) onClose();
            }}
          >
            <div
              className="flex shrink-0 cursor-grab touch-none justify-center pt-3 pb-1 md:hidden"
              onPointerDown={(e) => !locked && drag.start(e)}
              aria-hidden
            >
              <span className="h-1.5 w-10 rounded-full bg-white/20" />
            </div>
            {(title || description) && (
              <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-4 pb-2 md:pt-6">
                <div>
                  {title && <h2 className="text-xl font-bold">{title}</h2>}
                  {description && <p className="mt-1 text-sm text-fog">{description}</p>}
                </div>
                {!locked && (
                  <button
                    onClick={onClose}
                    aria-label="Close"
                    className="-mr-2 grid h-9 w-9 shrink-0 place-items-center rounded-full text-fog transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4">{children}</div>
            {footer && <div className="safe-bottom shrink-0 border-t border-white/[0.08] bg-ink-900/60 px-6 py-4">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
