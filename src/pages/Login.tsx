import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Check, Loader2, MessageSquareText, ShieldCheck, UserCog } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Atmosphere } from '../components/brand/Atmosphere';
import { AvatarFull } from '../components/brand/Avatar';
import { Logo } from '../components/brand/Logo';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { cn } from '../lib/cn';
import { ApiError, post } from '../lib/http';
import { getSource } from '../lib/source';
import type { Role } from '../lib/types';
import { useAuth } from '../state/auth';

type Step = 'phone' | 'otp' | 'done';
type OtpProblem = null | { kind: 'invalid' | 'throttled' | 'network'; message: string };

const prettyPhone = (p: string) => `+91 ${p.slice(0, 5)} ${p.slice(5)}`;
const homeFor = (role: Role) => (role === 'admin' ? '/admin' : role === 'worker' ? '/worker' : '/app');

function useTicker() {
  const [left, setLeft] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval>>(undefined);
  const start = useCallback((seconds: number) => {
    clearInterval(ref.current);
    setLeft(seconds);
    ref.current = setInterval(() => setLeft((l) => (l <= 1 ? (clearInterval(ref.current), 0) : l - 1)), 1000);
  }, []);
  useEffect(() => () => clearInterval(ref.current), []);
  return [left, start] as const;
}

export default function Login() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const staff = params.get('staff') === '1';
  const next = useMemo(() => {
    const n = params.get('next');
    return n && /^\/(app|worker|admin)(\/|$)/.test(n) ? n : null;
  }, [params]);

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [problem, setProblem] = useState<OtpProblem>(null);
  const [resendIn, startResend] = useTicker();
  const [shakeKey, setShakeKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Staff sign-in
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [staffError, setStaffError] = useState('');
  const [staffBusy, setStaffBusy] = useState(false);

  // Already signed in (and not mid-login): go straight through.
  if (user && step !== 'done' && !staffBusy) return <Navigate to={next && next.startsWith(homeFor(user.role)) ? next : homeFor(user.role)} replace />;

  const digits = phone.replace(/\D/g, '');

  const sendCode = async (isResend = false) => {
    if (!/^[6-9]\d{9}$/.test(digits)) {
      setPhoneError('Enter a valid 10-digit mobile number.');
      return;
    }
    setPhoneError('');
    setSending(true);
    setProblem(null);
    try {
      await post('/auth/otp/request', { phone: digits });
      startResend(30);
      setCode('');
      setStep('otp');
      if (isResend) inputRef.current?.focus();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'otp_cooldown') {
        // A code was just sent: show the entry screen with the wait before another can be requested.
        startResend(60);
        setCode('');
        setStep('otp');
      } else if (step === 'phone') {
        setPhoneError(err instanceof ApiError ? err.fields.phone ?? err.message : 'Something went wrong. Please try again.');
      } else {
        setProblem({ kind: 'network', message: err instanceof ApiError ? err.message : 'Could not send a new code.' });
      }
    } finally {
      setSending(false);
    }
  };

  const verify = async (value: string) => {
    setVerifying(true);
    setProblem(null);
    try {
      await post('/auth/otp/verify', { phone: digits, code: value, source: getSource() });
      // Signed in at the server. Load the profile before saying so: if that fails, show why instead of going quiet.
      const me = await refresh();
      setStep('done');
      setTimeout(() => navigate(next && next.startsWith(homeFor(me.role)) ? next : homeFor(me.role), { replace: true }), 800);
    } catch (err) {
      setVerifying(false);
      setCode('');
      setStep('otp');
      if (err instanceof ApiError) {
        const invalid = err.code === 'otp_invalid';
        setProblem({ kind: invalid ? 'invalid' : err.status === 429 ? 'throttled' : 'network', message: err.message });
        if (invalid) setShakeKey((k) => k + 1);
      } else {
        setProblem({ kind: 'network', message: 'Something went wrong. Please try again.' });
      }
      inputRef.current?.focus();
    }
  };

  const onCodeChange = (raw: string) => {
    const v = raw.replace(/\D/g, '').slice(0, 6);
    setCode(v);
    if (problem?.kind === 'invalid' || problem?.kind === 'network') setProblem(null);
    if (v.length === 6) void verify(v);
  };

  const staffSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStaffError('');
    setStaffBusy(true);
    try {
      const res = await post<{ role: Role }>('/auth/staff/login', { email, password });
      const me = await refresh();
      const home = homeFor(me.role ?? res.role);
      navigate(next && next.startsWith(home) ? next : home, { replace: true });
    } catch (err) {
      setStaffError(err instanceof ApiError ? err.fields.email ?? err.fields.password ?? err.message : 'Something went wrong. Please try again.');
      setStaffBusy(false);
    }
  };

  const switchMode = (toStaff: boolean) => {
    const p = new URLSearchParams(params);
    if (toStaff) p.set('staff', '1');
    else p.delete('staff');
    setParams(p, { replace: true });
  };

  return (
    <div className="min-h-dvh">
      <Atmosphere />
      <div className="mx-auto grid min-h-dvh max-w-6xl lg:grid-cols-2">
        <div className="relative hidden flex-col justify-between p-12 lg:flex">
          <Link to="/"><Logo showTagline /></Link>
          <div className="mx-auto w-full max-w-sm"><AvatarFull priority /></div>
          <p className="text-sm text-fog">Doorstep washing for Kharadi, Pune.</p>
        </div>

        <div className="flex flex-col px-4 py-6 sm:px-8">
          <div className="flex items-center justify-between lg:hidden">
            <Link to="/"><Logo /></Link>
            <Link to="/" className="text-sm text-fog hover:text-white">Back to site</Link>
          </div>

          <div className="flex flex-1 items-center justify-center py-8">
            <motion.div layout className="glass w-full max-w-md overflow-hidden p-6 sm:p-9" transition={{ layout: { duration: 0.3 } }}>
              <AnimatePresence mode="wait" initial={false}>
                {staff ? (
                  <motion.form key="staff" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} onSubmit={staffSubmit} noValidate className="space-y-5">
                    <span className="grid h-12 w-12 place-items-center rounded-2xl bg-washo-500/15 text-washo-300"><UserCog className="h-6 w-6" /></span>
                    <div>
                      <h1 className="text-3xl font-extrabold">Staff sign in</h1>
                      <p className="mt-2 text-fog">For WASHO specialists and admins. Use the email and password WASHO gave you.</p>
                    </div>
                    <Input label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
                    <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                    {staffError && <p role="alert" className="text-sm text-bad">{staffError}</p>}
                    <Button type="submit" size="lg" full loading={staffBusy} iconRight={<ArrowRight className="h-5 w-5" />}>Sign in</Button>
                    <button type="button" onClick={() => switchMode(false)} className="block w-full text-center text-sm text-fog hover:text-white">I'm a customer</button>
                  </motion.form>
                ) : (
                  <>
                    {step === 'phone' && (
                      <motion.form
                        key="phone"
                        initial={{ opacity: 0, x: 24 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -24 }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          void sendCode();
                        }}
                        noValidate
                      >
                        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-washo-500/15 text-washo-300"><MessageSquareText className="h-6 w-6" /></span>
                        <h1 className="mt-5 text-3xl font-extrabold">Welcome to WASHO</h1>
                        <p className="mt-2 text-fog">Enter your mobile number and we'll text you a 6-digit code. No password needed.</p>

                        <label htmlFor="phone" className="mt-7 mb-1.5 block text-[13px] font-medium text-mist">Mobile number</label>
                        <div className={cn('flex h-14 items-center overflow-hidden rounded-2xl border bg-white/[0.04] transition-colors focus-within:border-washo-400 focus-within:ring-4 focus-within:ring-washo-500/15', phoneError ? 'border-bad/60' : 'border-white/10')}>
                          <span className="flex h-full items-center border-r border-white/10 px-4 text-base font-semibold text-mist">+91</span>
                          <input
                            id="phone"
                            type="tel"
                            inputMode="numeric"
                            autoComplete="tel-national"
                            autoFocus
                            placeholder="98765 43210"
                            value={phone}
                            onChange={(e) => {
                              const d = e.target.value.replace(/\D/g, '').slice(0, 10);
                              setPhone(d.length > 5 ? `${d.slice(0, 5)} ${d.slice(5)}` : d);
                              setPhoneError('');
                            }}
                            aria-invalid={Boolean(phoneError)}
                            aria-describedby="phone-err"
                            className="h-full min-w-0 flex-1 bg-transparent px-4 text-lg font-semibold tracking-wide outline-none placeholder:font-normal placeholder:text-fog/50"
                          />
                        </div>
                        <p id="phone-err" role="alert" className="mt-2 min-h-5 text-[13px] text-bad">{phoneError}</p>

                        <Button type="submit" size="lg" full loading={sending} iconRight={<ArrowRight className="h-5 w-5" />} className="mt-3">
                          Send code
                        </Button>
                        <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-fog"><ShieldCheck className="h-3.5 w-3.5" /> We only use your number to sign you in and reach you about washes.</p>
                        <button type="button" onClick={() => switchMode(true)} className="mt-6 block w-full text-center text-xs text-fog/70 hover:text-white">WASHO staff sign in</button>
                      </motion.form>
                    )}

                    {step === 'otp' && (
                      <motion.div key="otp" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                        <button onClick={() => { setStep('phone'); setProblem(null); setCode(''); }} className="-ml-1 mb-4 inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-sm text-fog hover:text-white">
                          <ArrowLeft className="h-4 w-4" /> Change number
                        </button>
                        <h1 className="text-3xl font-extrabold">Enter your code</h1>
                        <p className="mt-2 text-fog">We sent a 6-digit code to <span className="font-semibold text-white">{prettyPhone(digits)}</span></p>

                        {/* One real input (so autofill/paste work) drawn as six cells. */}
                        <div key={shakeKey} className={cn('relative mt-7', shakeKey > 0 && problem?.kind === 'invalid' && 'animate-shake')}>
                          <input
                            ref={inputRef}
                            value={code}
                            onChange={(e) => onCodeChange(e.target.value)}
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern="\d{6}"
                            maxLength={6}
                            autoFocus
                            disabled={verifying}
                            aria-label="6-digit verification code"
                            aria-invalid={problem?.kind === 'invalid'}
                            className="absolute inset-0 z-10 h-full w-full cursor-text opacity-0"
                          />
                          <div className="flex justify-between gap-2" aria-hidden>
                            {Array.from({ length: 6 }).map((_, i) => {
                              const active = !verifying && i === Math.min(code.length, 5);
                              return (
                                <div
                                  key={i}
                                  className={cn(
                                    'grid h-14 flex-1 place-items-center rounded-2xl border font-display text-2xl font-bold transition-all sm:h-16',
                                    problem?.kind === 'invalid' ? 'border-bad/60 bg-bad/10' : code[i] ? 'border-washo-400/50 bg-washo-500/10' : 'border-white/10 bg-white/[0.04]',
                                    active && 'border-washo-400 ring-4 ring-washo-500/20',
                                    verifying && 'opacity-50'
                                  )}
                                >
                                  {code[i] ?? (active ? <span className="h-6 w-0.5 animate-pulse bg-washo-300" /> : '')}
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        <div className="mt-4 min-h-12" aria-live="polite">
                          {verifying && <p className="flex items-center gap-2 text-sm text-mist"><Loader2 className="h-4 w-4 animate-spin" /> Verifying…</p>}
                          {!verifying && problem && <p role="alert" className={cn('text-sm', problem.kind === 'invalid' ? 'text-bad' : 'text-warn')}>{problem.message}</p>}
                        </div>

                        <p className="mt-2 text-center text-sm text-fog">
                          Didn't get it?{' '}
                          {resendIn > 0 ? (
                            <span className="tabular-nums">Resend in {resendIn}s</span>
                          ) : (
                            <button onClick={() => void sendCode(true)} disabled={sending} className="font-semibold text-washo-300 hover:text-white disabled:opacity-50">
                              {sending ? 'Sending…' : 'Resend code'}
                            </button>
                          )}
                        </p>
                      </motion.div>
                    )}

                    {step === 'done' && (
                      <motion.div key="done" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} className="py-8 text-center">
                        <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 16 }} className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-ok/15 text-ok ring-8 ring-ok/10">
                          <Check className="h-10 w-10" strokeWidth={3} />
                        </motion.span>
                        <h1 className="mt-6 text-3xl font-extrabold">You're in</h1>
                        <p className="mt-2 text-fog">Taking you to WASHO…</p>
                      </motion.div>
                    )}
                  </>
                )}
              </AnimatePresence>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
}
