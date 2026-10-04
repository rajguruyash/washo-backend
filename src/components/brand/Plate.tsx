import { cn } from '../../lib/cn';
import { formatPlate } from '../../lib/format';

/** Registration number styled like an Indian number plate. */
export function Plate({ reg, className }: { reg: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-stretch overflow-hidden rounded-md border border-ink-950/40 bg-[#f4f1e6] text-ink-950 shadow-[0_2px_8px_rgb(0_0_0/0.4)]', className)} aria-label={`Registration ${formatPlate(reg)}`}>
      <span className="grid w-4 place-items-center bg-washo-800 text-[6px] font-bold leading-none text-white" aria-hidden>
        IND
      </span>
      <span className="whitespace-nowrap px-2 py-0.5 font-mono text-[13px] font-bold tracking-wider">{formatPlate(reg)}</span>
    </span>
  );
}
