import { motion, type HTMLMotionProps } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'glass' | 'ghost' | 'danger' | 'light';
type Size = 'sm' | 'md' | 'lg';

const base =
  'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-2xl font-semibold transition-colors duration-200 disabled:pointer-events-none disabled:opacity-50';

const variants: Record<Variant, string> = {
  primary:
    'bg-gradient-to-b from-washo-500 to-washo-700 text-white shadow-[0_8px_24px_-8px_rgb(42_98_230/0.8),inset_0_1px_0_rgb(255_255_255/0.22)] hover:from-washo-400 hover:to-washo-600',
  glass: 'border border-white/[0.12] bg-white/[0.06] text-white hover:bg-white/[0.1]', // no backdrop-blur: it sits in blurred cards, and Safari paints a nested blur solid white
  ghost: 'text-mist hover:bg-white/[0.06] hover:text-white',
  danger: 'border border-bad/30 bg-bad/10 text-bad hover:bg-bad/20',
  light: 'bg-white text-ink-950 hover:bg-washo-50',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-[13px]',
  md: 'h-11 px-5 text-sm',
  lg: 'h-14 px-7 text-base',
};

interface Common {
  variant?: Variant;
  size?: Size;
  full?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  className?: string;
}

export function Button({
  variant = 'primary',
  size = 'md',
  full,
  loading,
  icon,
  iconRight,
  className,
  children,
  disabled,
  ...rest
}: Common & { loading?: boolean } & Omit<HTMLMotionProps<'button'>, 'children'> & { children?: ReactNode }) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className={cn(base, variants[variant], sizes[size], full && 'w-full', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
      {!loading && iconRight}
    </motion.button>
  );
}

export function ButtonLink({
  variant = 'primary',
  size = 'md',
  full,
  icon,
  iconRight,
  className,
  children,
  ...rest
}: Common & LinkProps) {
  return (
    <Link className={cn(base, variants[variant], sizes[size], full && 'w-full', 'active:scale-[0.97]', className)} {...rest}>
      {icon}
      {children}
      {iconRight}
    </Link>
  );
}
