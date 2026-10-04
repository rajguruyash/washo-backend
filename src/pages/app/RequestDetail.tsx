import { ArrowLeft, CheckCircle2, Clock, Hourglass, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plate } from '../../components/brand/Plate';
import { ErrorState } from '../../components/EmptyState';
import { QuoteBreakdownView } from '../../components/Quote';
import { patternLabel } from '../../components/WashBits';
import { Badge } from '../../components/ui/Badge';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { prettyDate, rupees } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useAcceptQuote, useDeclineQuote, useEstimate, useRequest } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { usePay } from '../../lib/usePay';

const timeLeft = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  return d > 0 ? `${d} day${d > 1 ? 's' : ''} ${h}h` : `${Math.max(h, 0)} hours`;
};

export default function RequestDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: r, isLoading, isError, refetch } = useRequest(id);
  const accept = useAcceptQuote();
  const decline = useDeclineQuote();
  const { pay, paying } = usePay();
  const [confirmDecline, setConfirmDecline] = useState(false);
  // While WASHO is still reviewing, show the rate-card estimate so the customer knows roughly what to expect.
  const estimate = useEstimate(r?.status === 'submitted' ? { vehicle_type: r.vehicle_type, weekly_pattern: r.weekly_pattern, duration_months: r.duration_months } : null);

  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !r) return <div className="space-y-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;

  const startPayment = async () => {
    const result = await pay(() => accept.mutateAsync(r.id), `WASHO membership ${r.reference_code}`);
    if (result?.membership_id) navigate(`/app/membership/${result.membership_id}?new=1`, { replace: true });
  };

  const doDecline = async () => {
    try {
      await decline.mutateAsync(r.id);
      toast.success('Quote declined');
      setConfirmDecline(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not decline this quote.');
    }
  };

  const status = {
    submitted: { tone: 'amber', label: 'With WASHO', icon: <Hourglass className="h-3.5 w-3.5" /> },
    quoted: { tone: 'blue', label: 'Price ready', icon: <Clock className="h-3.5 w-3.5" /> },
    accepted: { tone: 'blue', label: 'Awaiting payment', icon: <Clock className="h-3.5 w-3.5" /> },
    active: { tone: 'green', label: 'Active', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    rejected: { tone: 'red', label: 'Not available', icon: <XCircle className="h-3.5 w-3.5" /> },
    declined: { tone: 'slate', label: 'Declined', icon: <XCircle className="h-3.5 w-3.5" /> },
    expired: { tone: 'slate', label: 'Quote expired', icon: <XCircle className="h-3.5 w-3.5" /> },
    cancelled: { tone: 'slate', label: 'Cancelled', icon: <XCircle className="h-3.5 w-3.5" /> },
  }[r.status] as { tone: 'amber' | 'blue' | 'green' | 'red' | 'slate'; label: string; icon: React.ReactNode };

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/app/membership" className="mb-5 inline-flex items-center gap-1.5 text-sm text-fog hover:text-white"><ArrowLeft className="h-4 w-4" /> Membership</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">{r.reference_code}</p>
          <h1 className="mt-1 text-3xl font-extrabold">{r.frequency_per_week} wash{r.frequency_per_week > 1 ? 'es' : ''} a week · {r.duration_months} month{r.duration_months > 1 ? 's' : ''}</h1>
        </div>
        <Badge tone={status.tone} icon={status.icon}>{status.label}</Badge>
      </div>

      <div className="glass divide-y divide-white/[0.07]">
        <div className="flex items-center justify-between gap-4 p-5"><div><p className="eyebrow">Vehicle</p><p className="mt-1 font-bold">{r.vehicle_make ? `${r.vehicle_make} ` : ''}{r.vehicle_model}</p></div><Plate reg={r.registration_number} /></div>
        <div className="p-5"><p className="eyebrow">Weekly schedule</p><p className="mt-1 text-sm">{patternLabel(r.weekly_pattern)}</p><p className="mt-1 text-xs text-fog">{slotLabel(r.time_slot)} · starting {prettyDate(r.start_date)}</p></div>
        {r.customer_notes && <div className="p-5"><p className="eyebrow">Your note</p><p className="mt-1 text-sm text-mist">{r.customer_notes}</p></div>}
      </div>

      <div className="mt-6">
        {r.status === 'submitted' && (
          <div className="glass p-6 text-center">
            <Hourglass className="mx-auto h-8 w-8 text-washo-300" />
            <h2 className="mt-3 text-xl font-bold">WASHO is reviewing your request</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-fog">You'll see your confirmed price here as soon as it's ready. Nothing is charged until you accept it.</p>
            {estimate.data && (
              <div className="mx-auto mt-5 max-w-sm rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-left">
                <div className="flex items-center justify-between"><p className="eyebrow">Estimate</p><Badge tone="amber">Not final</Badge></div>
                <p className="mt-1 font-display text-3xl font-extrabold tabular-nums">{rupees(estimate.data.final_cents)}</p>
                <p className="text-xs text-fog">From the rate card, with every discount included. WASHO confirms the final price.</p>
              </div>
            )}
          </div>
        )}

        {(r.status === 'quoted' || r.status === 'accepted') && r.quoted_breakdown && (
          <div className="glass p-6">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-bold">Your price</h2>
              {r.status === 'quoted' && r.quote_expires_at && <Badge tone="amber">Valid for {timeLeft(r.quote_expires_at)}</Badge>}
            </div>
            <QuoteBreakdownView q={r.quoted_breakdown} />
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Button size="lg" full loading={paying || accept.isPending} onClick={() => void startPayment()}>{r.status === 'accepted' ? 'Complete payment' : `Accept and pay ${rupees(r.quoted_amount_cents ?? 0)}`}</Button>
              {r.status === 'quoted' && <Button size="lg" variant="glass" onClick={() => setConfirmDecline(true)}>Decline</Button>}
            </div>
            <p className="mt-3 text-center text-xs text-fog">Your membership and washes are created only after your payment is verified.</p>
          </div>
        )}

        {r.status === 'active' && (
          <div className="glass p-6 text-center">
            <CheckCircle2 className="mx-auto h-9 w-9 text-ok" />
            <h2 className="mt-3 text-xl font-bold">Your membership is active</h2>
            <p className="mt-1 text-sm text-fog">All your washes are scheduled.</p>
            {r.membership_id && <ButtonLink to={`/app/membership/${r.membership_id}`} className="mt-5">See my washes</ButtonLink>}
          </div>
        )}

        {r.status === 'rejected' && (
          <div className="glass p-6">
            <h2 className="text-xl font-bold">We couldn't take this one</h2>
            <p className="mt-2 text-sm text-mist">{r.rejection_reason}</p>
            <ButtonLink to="/app/membership/new" className="mt-5" variant="glass">Try different options</ButtonLink>
          </div>
        )}

        {(r.status === 'expired' || r.status === 'declined' || r.status === 'cancelled') && (
          <div className="glass p-6 text-center">
            <p className="font-semibold">{r.status === 'expired' ? 'This quote has expired.' : 'This request is closed.'}</p>
            <ButtonLink to="/app/membership/new" className="mt-4">Start a new request</ButtonLink>
          </div>
        )}
      </div>

      {confirmDecline && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Decline quote">
          <div className="glass-strong w-full max-w-sm p-6">
            <h2 className="text-lg font-bold">Decline this price?</h2>
            <p className="mt-2 text-sm text-fog">The request will close. You can start a new one any time.</p>
            <div className="mt-5 grid grid-cols-2 gap-3"><Button variant="glass" onClick={() => setConfirmDecline(false)}>Keep it</Button><Button variant="danger" loading={decline.isPending} onClick={() => void doDecline()}>Decline</Button></div>
          </div>
        </div>
      )}
    </div>
  );
}
