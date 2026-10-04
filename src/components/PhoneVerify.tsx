import { ArrowRight, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { ApiError, post } from '../lib/http';
import { useAuth } from '../state/auth';
import { Button } from './ui/Button';
import { Input } from './ui/Field';

/**
 * A mobile number a specialist can ring, confirmed with a one-time code. Used for customers who signed in with Google, who have
 * no number yet. The number only becomes theirs once the code is confirmed.
 */
export function PhoneVerify({ onVerified }: { onVerified: () => void }) {
  const { refresh } = useAuth();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wait, setWait] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => () => clearInterval(timer.current), []);

  const digits = phone.replace(/\D/g, '');
  const startWait = (s: number) => {
    clearInterval(timer.current);
    setWait(s);
    timer.current = setInterval(() => setWait((w) => (w <= 1 ? (clearInterval(timer.current), 0) : w - 1)), 1000);
  };

  const send = async () => {
    if (!/^[6-9]\d{9}$/.test(digits)) return setError('Enter a valid 10-digit mobile number.');
    setError('');
    setBusy(true);
    try {
      await post('/auth/phone/request', { phone: digits });
      setSent(true);
      setCode('');
      startWait(30);
    } catch (err) {
      setError(err instanceof ApiError ? err.fields.phone ?? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    setError('');
    setBusy(true);
    try {
      await post('/auth/phone/verify', { phone: digits, code: value });
      onVerified(); // move on first, so the details form never flashes back while the profile reloads
      await refresh();
    } catch (err) {
      setCode('');
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sent) void send();
        else if (code.length >= 4) void verify(code);
      }}
    >
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-washo-500/15 text-washo-300"><Smartphone className="h-6 w-6" /></span>
      <div>
        <h1 className="text-2xl font-extrabold">Your mobile number</h1>
        <p className="mt-1 text-sm text-fog">Your specialist rings you before every wash, so we need a number that reaches you. We'll text a 6-digit code to confirm it.</p>
      </div>

      {!sent ? (
        <div>
          <label htmlFor="verify-phone" className="mb-1.5 block text-[13px] font-medium text-mist">Mobile number</label>
          <div className={cn('flex h-14 items-center overflow-hidden rounded-2xl border bg-white/[0.04] transition-colors focus-within:border-washo-400 focus-within:ring-4 focus-within:ring-washo-500/15', error ? 'border-bad/60' : 'border-white/10')}>
            <span className="flex h-full items-center border-r border-white/10 px-4 text-base font-semibold text-mist">+91</span>
            <input
              id="verify-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              autoFocus
              placeholder="98765 43210"
              value={phone}
              onChange={(e) => {
                const d = e.target.value.replace(/\D/g, '').slice(0, 10);
                setPhone(d.length > 5 ? `${d.slice(0, 5)} ${d.slice(5)}` : d);
                setError('');
              }}
              className="h-full min-w-0 flex-1 bg-transparent px-4 text-lg font-semibold tracking-wide outline-none placeholder:font-normal placeholder:text-fog/50"
            />
          </div>
        </div>
      ) : (
        <div>
          <Input
            label={`Code sent to +91 ${digits.slice(0, 5)} ${digits.slice(5)}`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            disabled={busy}
            value={code}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(v);
              setError('');
              if (v.length === 6) void verify(v);
            }}
            className="[&_input]:h-14 [&_input]:text-center [&_input]:font-display [&_input]:text-2xl [&_input]:tracking-[0.4em]"
          />
          <p className="mt-3 text-sm text-fog">
            <button type="button" onClick={() => { setSent(false); setError(''); }} className="font-semibold text-washo-300 hover:text-white">Change number</button>
            {' · '}
            {wait > 0 ? <span className="tabular-nums">Resend in {wait}s</span> : <button type="button" disabled={busy} onClick={() => void send()} className="font-semibold text-washo-300 hover:text-white disabled:opacity-50">Resend code</button>}
          </p>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <Button type="submit" size="lg" full loading={busy} iconRight={<ArrowRight className="h-5 w-5" />}>{sent ? 'Verify and continue' : 'Send code'}</Button>
    </form>
  );
}
