import { useRef } from 'react';
import { cn } from '../lib/cn';
import { COLOURS } from '../lib/colours';
import { Input } from './ui/Field';

/** The vehicle's colour: the usual ones to tap, or type another. It helps the specialist find the vehicle in a full parking. */
export function ColourField({ value, onChange, error, autoFocus }: { value: string; onChange: (v: string) => void; error?: string; autoFocus?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <Input ref={ref} label="Colour" placeholder="e.g. White, Silver, Red" value={value} onChange={(e) => onChange(e.target.value)} error={error} autoComplete="off" maxLength={30} autoFocus={autoFocus} required />
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Common colours">
        {COLOURS.map((c) => (
          <button key={c} type="button" aria-pressed={value.trim().toLowerCase() === c.toLowerCase()} onClick={() => onChange(c)} className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', value.trim().toLowerCase() === c.toLowerCase() ? 'border-washo-400/70 bg-washo-500/20 text-white' : 'border-white/10 text-mist hover:border-white/25')}>{c}</button>
        ))}
      </div>
    </div>
  );
}
