import { motion, type HTMLMotionProps } from 'framer-motion';
import type { ReactNode } from 'react';

/** Fade-and-rise on scroll into view. Used sparingly for section entrances on the landing page. */
export function Reveal({ children, delay = 0, ...rest }: { children: ReactNode; delay?: number } & HTMLMotionProps<'div'>) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

export const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.07 } } };
export const rise = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as const } },
};
