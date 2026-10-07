import { ArrowRight, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { ApiError, put } from '../lib/http';
import { useAuth } from '../state/auth';
import { Button } from './ui/Button';

/**
 * A mobile number for someone who signed in with their email: ten digits, +91, saved. No code and no confirmation: a specialist only needs a
 * number to ring before a wash. (A number that is already registered with WASHO, or that someone signs in with, is refused by the server.)
 */
export function PhoneEntry({ intro, compact = false, onSaved }: { intro?: string; compact?: boolean; onSaved?: () => void }) {
  const { refresh } = useAuth();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const digits = phone.replace(/\D/g, '');

  const save = async () => {
    if (!/^[6-9]\d{9}$/.test(digits)) return setError('Enter a valid 10-digit mobile number.');
    setError('');
    setBusy(true);
    try {
      await put('/me/phone', { phone: digits });
      await refresh(); // the number is on file now: whatever was waiting for it wakes up
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.fields.phone ?? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  return (
    <form noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div>
        {compact ? <h2 className="flex items-center gap-2 text-lg font-bold"><Smartphone className="h-5 w-5 text-washo-300" /> Add your mobile number to pay</h2> : <h1 className="text-2xl font-extrabold">Your mobile number</h1>}
        <p className="mt-1 text-sm text-fog">{intro ?? 'Your specialist rings you before every wash, so we need a number that reaches you.'}</p>
      </div>
      <div>
        <label htmlFor="entry-phone" className="mb-1.5 block text-[13px] font-medium text-mist">Mobile number</label>
        <div className={cn('flex h-14 items-center overflow-hidden rounded-2xl border bg-white/[0.04] transition-colors focus-within:border-washo-400 focus-within:ring-4 focus-within:ring-washo-500/15', error ? 'border-bad/60' : 'border-white/10')}>
          <span className="flex h-full items-center border-r border-white/10 px-4 text-base font-semibold text-mist">+91</span>
          <input
            id="entry-phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            placeholder="98765 43210"
            value={phone}
            aria-invalid={Boolean(error)}
            onChange={(e) => {
              const d = e.target.value.replace(/\D/g, '').slice(0, 10);
              setPhone(d.length > 5 ? `${d.slice(0, 5)} ${d.slice(5)}` : d);
              setError('');
            }}
            className="h-full min-w-0 flex-1 bg-transparent px-4 text-lg font-semibold tracking-wide outline-none placeholder:font-normal placeholder:text-fog/50"
          />
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <Button type="submit" size="lg" full loading={busy} iconRight={<ArrowRight className="h-5 w-5" />}>Save number</Button>
    </form>
  );
}
