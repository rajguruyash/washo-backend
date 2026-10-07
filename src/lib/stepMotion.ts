import { useState } from 'react';
import type { Variants } from 'framer-motion';

/** Content slides in the direction you are moving: from the right going forward, from the left going back. */
export const stepVariants: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 32 : -32 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -32 : 32 }),
};

/** 1 when the step went up, -1 when it went down. Use with stepVariants: `custom={dir}` on both AnimatePresence and the step. */
export function useStepDirection(step: number): number {
  const [prev, setPrev] = useState(step);
  const [dir, setDir] = useState(1);
  if (step !== prev) {
    setDir(step > prev ? 1 : -1);
    setPrev(step);
  }
  return dir;
}

/** Everything a step's motion.section needs. */
export const stepMotion = (dir: number) => ({ variants: stepVariants, custom: dir, initial: 'enter', animate: 'center', exit: 'exit', transition: { duration: 0.22 } }) as const;
