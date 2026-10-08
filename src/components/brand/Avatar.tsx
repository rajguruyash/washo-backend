import { motion } from 'framer-motion';
import fullUrl from '../../assets/brand/washo-avatar.webp';
import headUrl from '../../assets/brand/washo-avatar-head.webp';
import { cn } from '../../lib/cn';

/** The WASHO crew member, full length. Floats gently over a soft blue glow. */
export function AvatarFull({ className, priority }: { className?: string; priority?: boolean }) {
  return (
    <div className={cn('relative isolate', className)}>
      <div aria-hidden className="absolute inset-x-[8%] bottom-[2%] top-[18%] -z-10 rounded-full bg-washo-600/35 blur-[70px]" />
      <div aria-hidden className="absolute inset-x-[22%] bottom-0 -z-10 h-6 rounded-[50%] bg-black/60 blur-xl" />
      <motion.img
        src={fullUrl}
        width={896}
        height={1200}
        alt="A WASHO crew member in a navy WASHO cap and polo, holding a pressure washer"
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : undefined}
        decoding="async"
        draggable={false}
        className="relative mx-auto h-auto w-full select-none animate-float drop-shadow-[0_30px_40px_rgb(0_0_0/0.5)]"
        initial={{ opacity: 0, y: 30, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}

/** Face crop for small spaces: greetings, empty states, confirmations. */
export function AvatarHead({ className, ring = true }: { className?: string; ring?: boolean }) {
  return (
    <span
      className={cn(
        'relative inline-block shrink-0 overflow-hidden rounded-full bg-gradient-to-b from-washo-700/60 to-ink-800',
        ring && 'ring-2 ring-washo-400/50 ring-offset-2 ring-offset-ink-950',
        className ?? 'h-12 w-12'
      )}
    >
      <img src={headUrl} alt="WASHO crew" width={360} height={360} loading="lazy" decoding="async" className="h-full w-full object-cover" />
    </span>
  );
}
