import { Tag, X } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../lib/http';
import { percent } from '../lib/format';
import { Button } from './ui/Button';
import { Input } from './ui/Field';

/**
 * "Have a coupon?" on the last step of a booking. The customer types a code; `check` asks the server whether this customer can use it for this purchase (it answers with the
 * code and its percentage, or says in plain words why not), and only then is it applied. `applied` is the coupon that is part of the price now; `stopped` says it no longer
 * works (it ran out, or the plan changed to one it cannot go with), so it can be removed. The same box is used for memberships and for single washes.
 */
export function CouponBox({ applied, stopped, check, onApply, onRemove, id = 'pay-coupon' }: {
  applied: { code: string; bp?: number | null } | null;
  stopped?: string;
  check: (code: string) => Promise<{ code: string; bp?: number | null }>;
  onApply: (code: string) => void;
  onRemove: () => void;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    const code = text.trim();
    if (code.length < 3) return;
    setError('');
    setBusy(true);
    try {
      const ok = await check(code);
      onApply(ok.code);
      setText('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally { setBusy(false); }
  };

  return (
    <div id={id} className="glass mt-5 p-5">
      {applied ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm"><Tag className="h-4 w-4 text-ok" aria-hidden /> <span className="font-bold">{applied.code}</span> <span className="text-ok">{stopped ? '' : applied.bp ? `${percent(applied.bp)} extra off applied` : 'applied'}</span></p>
          <button type="button" onClick={() => { onRemove(); setError(''); }} className="inline-flex items-center gap-1 text-sm font-semibold text-washo-300 hover:text-white"><X className="h-4 w-4" aria-hidden /> Remove</button>
        </div>
      ) : open ? (
        <form onSubmit={(e) => { e.preventDefault(); void apply(); }} className="flex items-start gap-2">
          <Input label="Coupon code" className="min-w-0 flex-1" value={text} onChange={(e) => { setText(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20)); setError(''); }}
            autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="For example EXTRA5" error={error || undefined} />
          <Button type="submit" variant="glass" className="mt-[1.65rem]" loading={busy} disabled={text.trim().length < 3}>Apply</Button>
        </form>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 text-sm font-semibold text-washo-300 hover:text-white"><Tag className="h-4 w-4" aria-hidden /> Have a coupon?</button>
      )}
      {stopped && <p role="alert" className="mt-2 text-sm text-bad">{stopped}</p>}
    </div>
  );
}
