import { ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LEGAL, POLICY_LINKS } from '../pages/legal/facts';
import { ApiError } from '../lib/http';
import { useCreateTicket, useMySupport } from '../lib/queries';
import { Button } from './ui/Button';
import { Sheet } from './ui/Sheet';
import { useToast } from './ui/Toast';

const SUBJECT = 'Delete my account';
const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/**
 * Privacy and your data, on the Account page: the policies, and "Delete my account". A deletion request is raised as a complaint (so it is tracked, answered and finished by
 * the WASHO team within the number of days the privacy policy promises); nothing is deleted by pressing the button alone. Google Play and the App Store both ask for this
 * to be possible from inside the app.
 */
export function DeleteAccountCard() {
  const toast = useToast();
  const create = useCreateTicket();
  const tickets = useMySupport();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  const [sent, setSent] = useState<{ id: string; reference_code: string } | null>(null);
  // "Sign in to delete my account" on the public page arrives here with #delete
  useEffect(() => { if (location.hash === '#delete') setOpen(true); }, [location.hash]);

  const existing = (tickets.data ?? []).find((t) => t.subject === SUBJECT && (t.status === 'open' || t.status === 'in_progress'));
  const send = async () => {
    try {
      const r = await create.mutateAsync({
        category: 'other',
        subject: SUBJECT,
        message: `Please delete my WASHO account and my personal information. I understand that washes still to come are cancelled, that any membership ends, and that payment records the law requires are kept.`,
      });
      setSent(r.ticket);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send your request. Please try again.');
    }
  };
  const close = () => { setOpen(false); setSure(false); };

  return (
    <div id="delete" className="glass space-y-4 p-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold"><ShieldCheck className="h-5 w-5 text-washo-300" /> Privacy and your data</h2>
        <p className="mt-1 text-sm text-fog">What we keep, why, and how to have it deleted.</p>
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {POLICY_LINKS.filter((l) => l.to !== '/delete-account').map((l) => <li key={l.to}><Link to={l.to} className="font-semibold text-washo-300 hover:text-white">{l.label}</Link></li>)}
      </ul>
      {existing ? (
        <p className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm text-mist">
          You asked us to delete your account on {when(existing.created_at)}. We finish it within {LEGAL.deletionDays} days and will tell you here when it is done.{' '}
          <Link to={`/app/help/${existing.id}`} className="font-semibold text-washo-300 hover:text-white">See your request</Link>
        </p>
      ) : (
        <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setOpen(true)}>Delete my account</Button>
      )}

      <Sheet
        open={open}
        onClose={close}
        locked={create.isPending}
        size="sm"
        title={sent ? 'Request received' : 'Delete your account?'}
        description={sent ? undefined : `We delete or anonymise your personal information within ${LEGAL.deletionDays} days.`}
        footer={sent ? <Button full onClick={close}>Done</Button> : (
          <div className="grid grid-cols-2 gap-3">
            <Button variant="glass" disabled={create.isPending} onClick={close}>Keep my account</Button>
            <Button variant="danger" disabled={!sure} loading={create.isPending} onClick={() => void send()}>Send request</Button>
          </div>
        )}
      >
        {sent ? (
          <div className="space-y-3 text-sm text-mist">
            <p>We have your request ({sent.reference_code}). We will finish the deletion within {LEGAL.deletionDays} days, and you can follow it in Help.</p>
            <Link to={`/app/help/${sent.id}`} onClick={close} className="font-semibold text-washo-300 hover:text-white">Open your request</Link>
          </div>
        ) : (
          <div className="space-y-4 text-sm text-mist">
            <ul className="list-disc space-y-1.5 pl-5">
              <li>Your name, mobile number, email, addresses, vehicles, photos and messages are deleted or anonymised, and you are signed out for good.</li>
              <li>Washes still to come are cancelled (a paid single wash is refunded in full) and any membership ends.</li>
              <li>Payment and invoice records the law requires us to keep are kept without your other details.</li>
            </ul>
            <label className="flex items-start gap-2.5 rounded-2xl border border-white/10 p-3.5 text-sm">
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="mt-0.5 h-4 w-4" />
              <span>I understand, and I want my account deleted.</span>
            </label>
            <p className="text-xs text-fog">Full details: <Link to="/delete-account" className="font-semibold text-washo-300 hover:text-white">Delete your account</Link>.</p>
          </div>
        )}
      </Sheet>
    </div>
  );
}
