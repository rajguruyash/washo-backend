import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AvatarHead } from '../../components/brand/Avatar';
import { Logo } from '../../components/brand/Logo';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { ApiError } from '../../lib/http';
import { useSaveProfile } from '../../lib/queries';
import { useAuth } from '../../state/auth';

/**
 * First run: just a name, then the dashboard. Nothing else is asked up front: the vehicle is added when the customer first books (or chats with Woshi), and the address right before
 * they pay.
 */
export default function Welcome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // A new customer who came for something specific (the free wash) goes straight back to it; everyone else lands on the dashboard.
  const from = (useLocation().state as { from?: string } | null)?.from;
  const after = from && /^\/app\/claim(\?|$)/.test(from) ? from : '/app';
  const save = useSaveProfile();
  const [name, setName] = useState(user?.full_name ?? '');
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      // (the email, if they signed in with a number, is optional and can be added under Account; a mobile number, if they signed in by email, is asked for and verified when they pay)
      await save.mutateAsync({ full_name: name, email: user?.email ?? '' });
      navigate(after, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? (err.fields.full_name ?? err.message) : 'Something went wrong. Please try again.');
    }
  };

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-8"><Logo /></div>
      <form onSubmit={submit} className="glass space-y-5 p-6 sm:p-8" noValidate>
        <div className="flex items-center gap-4">
          <AvatarHead className="h-16 w-16" />
          <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.05] px-4 py-3 text-sm">Hi! I'm from the WASHO crew. What should we call you?</div>
        </div>
        <Input label="Your name" value={name} onChange={(e) => { setName(e.target.value); setError(''); }} autoComplete="name" autoFocus required />
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
        <Button type="submit" size="lg" full loading={save.isPending} disabled={!name.trim()} iconRight={<ArrowRight className="h-5 w-5" />}>Continue</Button>
      </form>
    </div>
  );
}
