import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Bike, Check } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AddressSheet } from '../../components/AddressSheet';
import { AvatarHead } from '../../components/brand/Avatar';
import { Logo } from '../../components/brand/Logo';
import { PhoneVerify } from '../../components/PhoneVerify';
import { VehicleSheet } from '../../components/VehicleSheet';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { ApiError } from '../../lib/http';
import { useAddresses, useSaveProfile } from '../../lib/queries';
import { useAuth } from '../../state/auth';

/** First run: who you are, where we find you, your first vehicle. After this a plan is a few taps. */
export default function Welcome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const save = useSaveProfile();
  const { data: addresses } = useAddresses();
  const [step, setStep] = useState<0 | 1 | 2>(user && !user.needs_profile ? 1 : 0);
  // Signed in with Google: no mobile number yet. It is confirmed with a code before the first booking, right after the details.
  const [detailsSaved, setDetailsSaved] = useState(Boolean(user?.full_name));
  const needsPhone = Boolean(user) && !user?.phone;
  const [form, setForm] = useState({ full_name: user?.full_name ?? '', email: user?.email ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [addrOpen, setAddrOpen] = useState(false);
  const [vehOpen, setVehOpen] = useState(false);
  const hasAddress = Boolean(addresses?.length);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setFormError('');
    try {
      await save.mutateAsync(form);
      setDetailsSaved(true);
      if (!needsPhone) setStep(1);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  const first = form.full_name.trim().split(' ')[0];
  const slide = { initial: { opacity: 0, x: 30 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -30 } };

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-8 flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-2" aria-label={`Step ${step + 1} of 3`}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={`h-1.5 rounded-full transition-all duration-500 ${i === step ? 'w-8 bg-washo-400' : i < step ? 'w-4 bg-washo-600' : 'w-4 bg-white/15'}`} />
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {step === 0 && needsPhone && detailsSaved && (
          <motion.div key="a-phone" {...slide} className="glass p-6 sm:p-8">
            <PhoneVerify onVerified={() => setStep(1)} />
          </motion.div>
        )}
        {step === 0 && !(needsPhone && detailsSaved) && (
          <motion.form key="a" {...slide} onSubmit={submit} className="glass space-y-5 p-6 sm:p-8" noValidate>
            <div className="flex items-center gap-4">
              <AvatarHead className="h-16 w-16" />
              <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.05] px-4 py-3 text-sm">Hi! I'm from the WASHO crew. Let's get you set up. It takes about a minute.</div>
            </div>
            <div>
              <h1 className="text-2xl font-extrabold">About you</h1>
              <p className="mt-1 text-sm text-fog">So our crew knows who to look for.</p>
            </div>
            <Input label="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} error={errors.full_name} autoComplete="name" autoFocus required />
            <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={errors.email} hint="For receipts and quotes." optional autoComplete="email" />
            {formError && <p role="alert" className="text-sm text-bad">{formError}</p>}
            <Button type="submit" size="lg" full loading={save.isPending} iconRight={<ArrowRight className="h-5 w-5" />}>Continue</Button>
          </motion.form>
        )}
        {step === 1 && (
          <motion.div key="b" {...slide} className="glass p-6 text-center sm:p-8">
            <AvatarHead className="mx-auto h-20 w-20" />
            <h1 className="mt-5 text-2xl font-extrabold">Nice to meet you{first ? `, ${first}` : ''}!</h1>
            <p className="mx-auto mt-2 max-w-sm text-fog">Where should we wash your vehicle? Add the society and parking spot once.</p>
            <div className="mt-8 space-y-3">
              {hasAddress ? (
                <Button size="lg" full icon={<Check className="h-5 w-5" />} onClick={() => setStep(2)}>Address saved. Continue</Button>
              ) : (
                <Button size="lg" full onClick={() => setAddrOpen(true)}>Add my address</Button>
              )}
            </div>
          </motion.div>
        )}
        {step === 2 && (
          <motion.div key="c" {...slide} className="glass p-6 text-center sm:p-8">
            <AvatarHead className="mx-auto h-20 w-20" />
            <h1 className="mt-5 text-2xl font-extrabold">Add your vehicle</h1>
            <p className="mx-auto mt-2 max-w-sm text-fog">Save it once and starting a membership is a few taps.</p>
            <div className="mt-8 space-y-3">
              <Button size="lg" full icon={<Bike className="h-5 w-5" />} onClick={() => setVehOpen(true)}>Add my vehicle</Button>
              <Button variant="ghost" full onClick={() => navigate('/app', { replace: true })}>I'll do this later</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AddressSheet open={addrOpen} onClose={() => setAddrOpen(false)} onSaved={() => setStep(2)} />
      <VehicleSheet open={vehOpen} onClose={() => setVehOpen(false)} onSaved={() => navigate('/app/membership/new', { replace: true })} />
    </div>
  );
}
