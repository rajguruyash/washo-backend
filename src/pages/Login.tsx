import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Loader2, Mail, MessageSquareText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AvatarFull } from '../components/brand/Avatar';
import { Logo } from '../components/brand/Logo';
import { LoginCelebration } from '../components/LoginCelebration';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { cn } from '../lib/cn';
import { ApiError, post } from '../lib/http';
import { getSource } from '../lib/source';
import type { Role } from '../lib/types';
import { useAuth } from '../state/auth';

type Step = 'phone' | 'otp' | 'done';
const CELEBRATE_MS = 1900; // how long the "you're in" pop-up stays before the page moves on
type OtpProblem = null | { kind: 'invalid' | 'throttled' | 'network'; message: string };

const prettyPhone = (p: string) => `+91 ${p.slice(0, 5)} ${p.slice(5)}`;
const signInErrors: Record<string, string> = {
  archived: 'This account has been deactivated. Please contact WASHO.',
  admin_use_email: 'Admins sign in with their email and password.',
};

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
  const emailMode = params.get('mode') === 'email' || params.get('staff') === '1'; // ?staff=1 is the older link, kept working
  const problemCode = params.get('error');
  const next = useMemo(() => {
    const n = params.get('next');
    return n && /^\/(app|worker|admin)(\/|$)/.test(n) ? n : null;
  }, [params]);

  const [step, setStep] = useState<Step>('phone');
  const [welcomeName, setWelcomeName] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [problem, setProblem] = useState<OtpProblem>(null);
  const [resendIn, startResend] = useTicker();
  const [shakeKey, setShakeKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Email sign-in: an email and a password (to sign in, or to create an account: no code, no verification email). An ADMIN's password is only the first
  // step: a code is then emailed to them and entered on the second screen.
  const [emailStep, setEmailStep] = useState<'form' | 'code'>('form');
  const [tab, setTab] = useState<'signin' | 'signup'>(params.get('tab') === 'signup' ? 'signup' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [emailError, setEmailError] = useState<{ field?: 'email' | 'password'; message: string } | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailHint, setEmailHint] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailProblem, setEmailProblem] = useState('');
  const [emailVerifying, setEmailVerifying] = useState(false);

  // Already signed in (and not mid-login): go straight through.
  if (user && step !== 'done' && !emailBusy && !emailVerifying) return <Navigate to={next && next.startsWith(homeFor(user.role)) ? next : homeFor(user.role)} replace />;

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
      setWelcomeName(me.full_name ?? null);
      setStep('done');
      setTimeout(() => navigate(next && next.startsWith(homeFor(me.role)) ? next : homeFor(me.role), { replace: true }), CELEBRATE_MS);
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

  const finishSignIn = async (fallbackRole: Role) => {
    const me = await refresh();
    const home = homeFor(me.role ?? fallbackRole);
    if (me.role === 'customer') {
      // customers get the pop-up; specialists and admins go straight to their console
      setWelcomeName(me.full_name ?? null);
      setStep('done');
      setTimeout(() => navigate(next && next.startsWith(home) ? next : home, { replace: true }), CELEBRATE_MS);
    } else navigate(next && next.startsWith(home) ? next : home, { replace: true });
  };

  const emailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(addr)) return setEmailError({ field: 'email', message: 'Enter a valid email address.' });
    if (!password) return setEmailError({ field: 'password', message: tab === 'signup' ? 'Choose a password.' : 'Enter your password.' });
    setEmailError(null);
    setEmailBusy(true);
    try {
      const res = await post<{ role?: Role; step?: 'code'; email_hint?: string }>(tab === 'signup' ? '/auth/email/signup' : '/auth/email/login', tab === 'signup' ? { email: addr, password, source: getSource() } : { email: addr, password });
      if (res.step === 'code') {
        // An admin: the password was right; a code has been emailed.
        setEmailHint(res.email_hint ?? '');
        setEmailCode('');
        setEmailProblem('');
        setEmailStep('code');
        startResend(30);
        setEmailBusy(false);
        return;
      }
      await finishSignIn(res.role ?? 'customer');
    } catch (err) {
      setEmailBusy(false);
      if (err instanceof ApiError) setEmailError({ field: err.fields.email ? 'email' : err.fields.password ? 'password' : undefined, message: err.fields.email ?? err.fields.password ?? err.message });
      else setEmailError({ message: 'Something went wrong. Please try again.' });
    }
  };

  const verifyEmailCode = async (value: string) => {
    setEmailVerifying(true);
    setEmailProblem('');
    try {
      await post('/auth/admin/code/verify', { code: value });
      await finishSignIn('admin');
    } catch (err) {
      setEmailVerifying(false);
      if (err instanceof ApiError && (err.code === 'step_expired' || err.code === 'too_many_codes')) {
        // The step is over: back to the password, with the reason.
        setEmailStep('form');
        setPassword('');
        setEmailError({ message: err.message });
        return;
      }
      setEmailProblem(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  const resendEmailCode = async () => {
    setSending(true);
    setEmailProblem('');
    try {
      const r = await post<{ email_hint?: string }>('/auth/admin/code/resend', {});
      if (r.email_hint) setEmailHint(r.email_hint);
      setEmailCode('');
      startResend(30);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'step_expired') {
        setEmailStep('form');
        setPassword('');
        setEmailError({ message: err.message });
      } else setEmailProblem(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const switchMode = (toEmail: boolean) => {
    const p = new URLSearchParams(params);
    p.delete('staff');
    p.delete('error');
    if (toEmail) {
      p.set('mode', 'email');
      setEmailStep('form');
      setEmailError(null);
    } else p.delete('mode');
    setParams(p, { replace: true });
  };

  return (
    <div className="min-h-dvh">
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
              {params.get('reason') === 'idle' && <p role="status" className="mb-5 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">You were signed out because you were away for a while. Please sign in again.</p>}
              <AnimatePresence mode="wait" initial={false}>
                {emailMode ? (
                  emailStep === 'form' ? (
                    <motion.form
                      key="email-form"
                      initial={{ opacity: 0, x: 24 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -24 }}
                      onSubmit={(e) => void emailSubmit(e)}
                      noValidate
                      className="space-y-5"
                    >
                      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-washo-500/15 text-washo-300"><Mail className="h-6 w-6" /></span>
                      <div>
                        <h1 className="text-3xl font-extrabold">{tab === 'signup' ? 'Create your account' : 'Sign in with email'}</h1>
                        <p className="mt-2 text-fog">{tab === 'signup' ? 'Choose a password: 8 or more characters, with letters and a number. No code to wait for.' : 'Enter your email and password.'}</p>
                      </div>
                      <div role="tablist" aria-label="Sign in or create an account" className="grid grid-cols-2 gap-1 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-1">
                        {([['signin', 'Sign in'], ['signup', 'Create account']] as const).map(([v, label]) => (
                          <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => { setTab(v); setEmailError(null); }} className={cn('rounded-xl px-3 py-2 text-sm font-semibold transition-colors', tab === v ? 'border border-white/[0.1] bg-white/[0.09] text-white' : 'border border-transparent text-fog hover:text-mist')}>{label}</button>
                        ))}
                      </div>
                      <Input label="Email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => { setEmail(e.target.value); setEmailError(null); }} error={emailError?.field === 'email' ? emailError.message : undefined} autoFocus required />
                      <div className="relative">
                        <Input label="Password" type={showPw ? 'text' : 'password'} autoComplete={tab === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => { setPassword(e.target.value); setEmailError(null); }} error={emailError?.field === 'password' ? emailError.message : undefined} required className="[&_input]:pr-12" />
                        <button type="button" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw} className="absolute right-2 top-[2.05rem] grid h-9 w-9 place-items-center rounded-xl text-fog hover:bg-white/10 hover:text-white">{showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                      </div>
                      {emailError && !emailError.field && <p role="alert" className="rounded-xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">{emailError.message}</p>}
                      <Button type="submit" size="lg" full loading={emailBusy} iconRight={<ArrowRight className="h-5 w-5" />}>{tab === 'signup' ? 'Create account' : 'Sign in'}</Button>
                      {problemCode && signInErrors[problemCode] && <p role="alert" className="rounded-xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">{signInErrors[problemCode]}</p>}
                      <div className="grid gap-1 pt-1 text-center text-sm">
                        {tab === 'signin' && <p className="text-fog">Forgot your password? Use your mobile number instead.</p>}
                        <button type="button" onClick={() => switchMode(false)} className="text-fog hover:text-white">Use my mobile number instead</button>
                      </div>
                    </motion.form>
                  ) : (
                    <motion.form
                      key="email-code"
                      initial={{ opacity: 0, x: 24 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -24 }}
                      onSubmit={(e) => { e.preventDefault(); if (/^\d{4,10}$/.test(emailCode)) void verifyEmailCode(emailCode); else setEmailProblem('Paste the code from the email.'); }}
                      noValidate
                      className="space-y-5"
                    >
                      <button type="button" onClick={() => { setEmailStep('form'); setEmailProblem(''); setEmailCode(''); setPassword(''); }} className="-ml-1 inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-sm text-fog hover:text-white">
                        <ArrowLeft className="h-4 w-4" /> Back
                      </button>
                      <div>
                        <h1 className="text-3xl font-extrabold">Check your email</h1>
                        <p className="mt-2 text-fog">Your password was right. For your security we sent a code to <span className="break-all font-semibold text-white">{emailHint || 'your email'}</span>. Copy it and paste it here. It can take a minute to arrive; look in spam too.</p>
                      </div>
                      <Input
                        label="Code from the email"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={10}
                        autoFocus
                        disabled={emailVerifying}
                        value={emailCode}
                        error={emailProblem}
                        onChange={(e) => { setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 10)); setEmailProblem(''); }}
                        onPaste={(e) => {
                          const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 10);
                          if (pasted.length >= 6) { e.preventDefault(); setEmailCode(pasted); void verifyEmailCode(pasted); } // a pasted code signs in at once (its length is Supabase's setting)
                        }}
                        className="[&_input]:h-14 [&_input]:text-center [&_input]:font-display [&_input]:text-2xl [&_input]:tracking-[0.35em]"
                      />
                      <Button type="submit" size="lg" full loading={emailVerifying} iconRight={<ArrowRight className="h-5 w-5" />}>Verify and sign in</Button>
                      <p className="text-center text-sm text-fog">
                        Didn't get it?{' '}
                        {resendIn > 0 ? <span className="tabular-nums">Resend in {resendIn}s</span> : <button type="button" onClick={() => void resendEmailCode()} disabled={sending} className="font-semibold text-washo-300 hover:text-white disabled:opacity-50">{sending ? 'Sending…' : 'Send a new code'}</button>}
                      </p>
                    </motion.form>
                  )
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

                        {problemCode && signInErrors[problemCode] && <p role="alert" className="mt-4 rounded-xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">{signInErrors[problemCode]}</p>}

                        <div className="my-6 flex items-center gap-3 text-xs text-fog/70" aria-hidden><span className="h-px flex-1 bg-white/10" />or<span className="h-px flex-1 bg-white/10" /></div>
                        {/* no backdrop-blur here: the card is already blurred, and Safari paints a nested blur solid white */}
                        <button type="button" onClick={() => switchMode(true)} className="inline-flex h-14 w-full items-center justify-center gap-3 rounded-2xl border border-white/[0.12] bg-white/[0.06] text-base font-semibold text-white transition-colors hover:bg-white/[0.1]"><Mail className="h-5 w-5 text-washo-300" /> Continue with Email</button>
                      </motion.form>
                    )}

                    {step === 'otp' && (
                      <motion.div key="otp" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                        <button onClick={() => { setStep('phone'); setProblem(null); setCode(''); }} className="-ml-1 mb-4 inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-sm text-fog hover:text-white">
                          <ArrowLeft className="h-4 w-4" /> Change number
                        </button>
                        <h1 className="text-3xl font-extrabold">Enter your code</h1>
                        <p className="mt-2 text-fog">We sent a code to <span className="font-semibold text-white">{prettyPhone(digits)}</span></p>

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

                  </>
                )}
              </AnimatePresence>
              {/* outside the AnimatePresence above, whose initial={false} would skip the pop-up's own opening animation */}
              {step === 'done' && <LoginCelebration name={welcomeName} ms={CELEBRATE_MS} />}
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
}
