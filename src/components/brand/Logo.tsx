import { cn } from '../../lib/cn';
import full from '../../assets/brand/washo-logo-full.webp';
import mark from '../../assets/brand/washo-mark.webp';
import wordmark from '../../assets/brand/washo-logo-wordmark.webp';

/**
 * The WASHO brand logo. On the dark interface the lettering is white and the swirl keeps its brand blues
 * (the original artwork is dark blue lettering for light backgrounds: src/assets/brand/washo-logo-original.webp).
 */
export function LogoMark({ className }: { className?: string }) {
  return <img src={mark} alt="" aria-hidden width={200} height={192} className={cn('h-8 w-auto', className)} />;
}

export function Logo({ className, showTagline }: { className?: string; showTagline?: boolean }) {
  return showTagline ? (
    <img src={full} alt="WASHO. Clean today, shine everyday." width={560} height={187} decoding="async" className={cn('h-14 w-auto', className)} />
  ) : (
    <img src={wordmark} alt="WASHO" width={560} height={159} decoding="async" className={cn('h-9 w-auto', className)} />
  );
}
