import { motion } from 'framer-motion';
import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

/** Tabs with a sliding pill. Scrolls horizontally on narrow screens instead of wrapping. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  label: string;
}) {
  const id = useId();
  return (
    <div role="tablist" aria-label={label} className="no-scrollbar flex gap-1 overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.03] p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative flex-1 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition-colors',
              active ? 'text-white' : 'text-fog hover:text-mist'
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-xl border border-white/[0.1] bg-white/[0.09]"
                transition={{ type: 'spring', stiffness: 500, damping: 36 }}
              />
            )}
            <span className="relative flex items-center justify-center gap-2">
              {o.label}
              {o.count !== undefined && o.count > 0 && (
                <span className={cn('rounded-full px-1.5 text-[11px]', active ? 'bg-washo-500/30 text-washo-300' : 'bg-white/10 text-fog')}>{o.count}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
