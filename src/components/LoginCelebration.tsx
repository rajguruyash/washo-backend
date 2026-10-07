import { motion, useReducedMotion } from 'framer-motion';
import { createPortal } from 'react-dom';
import { LogoMark } from './brand/Logo';

const COLORS = ['#9bbfff', '#6a9cff', '#ffd84d', '#ffffff', '#3dd9a0'];
// Fourteen droplets thrown outward from the tick, each with its own distance, size and delay (fixed, so it never re-rolls on a re-render).
const DROPS = Array.from({ length: 14 }, (_, i) => {
  const angle = (i / 14) * Math.PI * 2 + (i % 2 ? 0.18 : -0.12);
  const far = 78 + ((i * 37) % 38);
  return { x: Math.cos(angle) * far, y: Math.sin(angle) * far, size: 5 + ((i * 7) % 6), delay: 0.28 + (i % 5) * 0.03, color: COLORS[i % COLORS.length], round: i % 3 !== 0 };
});

/**
 * The moment after sign-in: a pop-up that says so properly. A tick draws itself inside ripples of water, droplets fly off it, the
 * customer is greeted by name word by word, and a bar fills while WASHO opens behind it. It stays up for `ms`, then the page moves on.
 */
export function LoginCelebration({ name, ms = 1800 }: { name?: string | null; ms?: number }) {
  const reduce = useReducedMotion();
  const first = name?.trim().split(/\s+/)[0];
  const words = (first ? `Welcome back, ${first}` : 'Welcome to WASHO').split(' ');
  return createPortal(
    <motion.div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[110] grid place-items-center bg-ink-950/80 px-4 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="glass-strong relative w-full max-w-sm overflow-hidden px-8 pb-8 pt-10 text-center"
        initial={{ opacity: 0, scale: 0.88, y: 18 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 22 }}
      >
        {/* a soft glow behind the tick */}
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-4 h-48 w-48 -translate-x-1/2 rounded-full bg-washo-500/25 blur-3xl" />

        <div className="relative mx-auto grid h-28 w-28 place-items-center">
          {!reduce && [0, 1, 2].map((i) => (
            <motion.span
              key={i}
              aria-hidden
              className="absolute inset-0 rounded-full border-2 border-washo-300/60"
              initial={{ scale: 0.5, opacity: 0.8 }}
              animate={{ scale: 2.1, opacity: 0 }}
              transition={{ duration: 1.5, delay: 0.15 + i * 0.35, repeat: Infinity, ease: 'easeOut' }}
            />
          ))}
          {!reduce && DROPS.map((d, i) => (
            <motion.span
              key={i}
              aria-hidden
              className="absolute left-1/2 top-1/2"
              style={{ width: d.size, height: d.size, marginLeft: -d.size / 2, marginTop: -d.size / 2, background: d.color, borderRadius: d.round ? '9999px' : '2px' }}
              initial={{ x: 0, y: 0, opacity: 0, scale: 0.3 }}
              animate={{ x: d.x, y: d.y, opacity: [0, 1, 0], scale: [0.3, 1, 0.5], rotate: d.round ? 0 : 140 }}
              transition={{ duration: 0.95, delay: d.delay, ease: 'easeOut' }}
            />
          ))}
          <svg viewBox="0 0 96 96" className="relative h-24 w-24" fill="none" aria-hidden>
            <motion.circle cx="48" cy="48" r="42" stroke="#3dd9a0" strokeWidth="5" strokeLinecap="round" initial={{ pathLength: reduce ? 1 : 0, rotate: -90 }} animate={{ pathLength: 1 }} style={{ originX: '50%', originY: '50%' }} transition={{ duration: 0.55, ease: 'easeOut' }} />
            <motion.circle cx="48" cy="48" r="34" fill="#3dd9a0" fillOpacity="0.14" initial={{ scale: reduce ? 1 : 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ originX: '50%', originY: '50%' }} transition={{ delay: 0.15, type: 'spring', stiffness: 200, damping: 14 }} />
            <motion.path d="M30 50 L43 63 L67 36" stroke="#3dd9a0" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: reduce ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.4, duration: 0.35, ease: 'easeOut' }} />
          </svg>
        </div>

        <h1 className="relative mt-6 text-3xl font-extrabold leading-tight" aria-label={words.join(' ')}>
          {words.map((w, i) => (
            <motion.span key={`${w}-${i}`} aria-hidden className="inline-block" initial={{ opacity: 0, y: 12, filter: reduce ? 'blur(0px)' : 'blur(8px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ delay: 0.5 + i * 0.12, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>{w}{i < words.length - 1 ? '\u00a0' : ''}</motion.span>
          ))}
        </h1>
        <motion.p className="relative mt-2 text-sm text-fog" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.95 }}>Your washes are ready for you.</motion.p>

        <div className="relative mt-7 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden>
          <motion.div className="h-full rounded-full bg-gradient-to-r from-washo-500 via-washo-300 to-offer" initial={{ width: '0%' }} animate={{ width: '100%' }} transition={{ duration: Math.max(ms - 200, 400) / 1000, ease: [0.4, 0, 0.2, 1] }} />
        </div>
        <div className="relative mt-5 flex items-center justify-center gap-2 text-xs text-fog"><LogoMark className="h-5 opacity-80" /> <span>Opening WASHO…</span></div>
      </motion.div>
    </motion.div>,
    document.body
  );
}
