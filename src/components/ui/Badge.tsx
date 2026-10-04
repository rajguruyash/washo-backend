import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type Tone = 'blue' | 'green' | 'amber' | 'red' | 'slate' | 'yellow';

const tones: Record<Tone, string> = {
  blue: 'border-washo-500/30 bg-washo-500/15 text-washo-300',
  green: 'border-ok/30 bg-ok/12 text-ok',
  amber: 'border-warn/30 bg-warn/12 text-warn',
  red: 'border-bad/30 bg-bad/12 text-bad',
  slate: 'border-white/10 bg-white/[0.06] text-mist',
  yellow: 'border-offer/30 bg-offer/12 text-offer',
};

export function Badge({ tone = 'slate', icon, children, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold', tones[tone], className)}>
      {icon}
      {children}
    </span>
  );
}
