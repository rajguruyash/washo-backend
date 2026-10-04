import { useId } from 'react';
import { cn } from '../../lib/cn';

/** Swirl mark. Drawn in SVG so it stays crisp at any size. */
export function LogoMark({ className }: { className?: string }) {
  // Gradient ids must be unique per instance: a duplicate inside a display:none ancestor (e.g. the
  // hidden desktop sidebar) captures the id and every later copy renders with no stroke.
  const uid = useId().replace(/:/g, '');
  const a = `wm-a-${uid}`;
  const b = `wm-b-${uid}`;
  return (
    <svg viewBox="0 0 48 48" className={cn('h-8 w-8', className)} aria-hidden>
      <defs>
        <linearGradient id={a} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9bbfff" />
          <stop offset="1" stopColor="#2a62e6" />
        </linearGradient>
        <linearGradient id={b} x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6a9cff" />
          <stop offset="1" stopColor="#1248b8" />
        </linearGradient>
      </defs>
      <path d="M24 5a19 19 0 1 0 19 19" fill="none" stroke={`url(#${a})`} strokeWidth="6" strokeLinecap="round" />
      <path d="M24 13a11 11 0 0 1 11 11" fill="none" stroke={`url(#${b})`} strokeWidth="6" strokeLinecap="round" />
      <circle cx="24" cy="24" r="4.5" fill={`url(#${a})`} />
    </svg>
  );
}

export function Logo({ className, showTagline }: { className?: string; showTagline?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="flex flex-col leading-none">
        <span className="font-display text-xl font-extrabold tracking-[0.04em] italic">WASHO</span>
        {showTagline && <span className="mt-1 text-[9px] font-semibold uppercase tracking-[0.2em] text-fog">Clean today. Shine everyday.</span>}
      </span>
    </span>
  );
}
