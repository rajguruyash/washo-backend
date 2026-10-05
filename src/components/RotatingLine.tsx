import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { cn } from '../lib/cn';

/** One line that swaps between phrases with a soft blur. The space of the longest phrase is reserved, so nothing below it jumps. */
export function RotatingLine({ phrases, interval = 3200, className }: { phrases: string[]; interval?: number; className?: string }) {
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduce || phrases.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % phrases.length), interval);
    return () => clearInterval(t);
  }, [reduce, interval, phrases.length]);
  const longest = phrases.reduce((a, b) => (b.length > a.length ? b : a), '');
  return (
    <span className={cn('relative block', className)}>
      <span aria-hidden className="invisible block">{longest}</span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={i}
          className="absolute inset-0 block"
          initial={reduce ? false : { opacity: 0, y: 14, filter: 'blur(8px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -14, filter: 'blur(8px)' }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        >
          {phrases[i]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
