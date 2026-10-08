import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { TextArea } from '../../components/ui/Field';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/http';
import { useMySupportTicket, useReplyTicket } from '../../lib/queries';
import { CUSTOMER_STATUS_TEXT as STATUS_TEXT, STATUS_TONE } from '../../lib/support';

const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** One complaint: what was said on both sides, and a box to write back. */
export default function HelpTicket() {
  const { id } = useParams();
  const { data, isLoading, isError, refetch } = useMySupportTicket(id);
  const reply = useReplyTicket(id ?? '');
  const toast = useToast();
  const [text, setText] = useState('');
  if (isError) return <ErrorState message="We could not open that complaint." onRetry={() => void refetch()} />;
  if (isLoading || !data) return <div className="space-y-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-48" /></div>;
  const t = data.ticket;
  const send = async () => {
    try { await reply.mutateAsync(text.trim()); setText(''); toast.success('Sent'); } catch (err) { toast.error(err instanceof ApiError ? err.message : 'Could not send that.'); }
  };
  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/app/help" className="mb-5 inline-flex items-center gap-1.5 text-sm text-fog hover:text-white"><ArrowLeft className="h-4 w-4" /> Help</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div><p className="eyebrow">{t.reference_code}</p><h1 className="mt-1 text-2xl font-extrabold">{t.subject}</h1>{t.booking_reference && <p className="mt-1 text-sm text-fog">About wash {t.booking_reference}</p>}</div>
        <Badge tone={STATUS_TONE[t.status]}>{STATUS_TEXT[t.status]}</Badge>
      </div>
      <ul className="space-y-3">
        {data.messages.map((m) => (
          <li key={m.id} className={m.from_admin ? 'mr-6 rounded-2xl rounded-tl-md border border-washo-500/30 bg-washo-500/10 p-4' : 'ml-6 rounded-2xl rounded-tr-md border border-white/10 bg-white/[0.04] p-4'}>
            <p className="flex items-baseline justify-between gap-2 text-xs text-fog"><span className="font-semibold text-mist">{m.from_admin ? 'WASHO' : 'You'}</span><span>{when(m.created_at)}</span></p>
            <p className="mt-1.5 whitespace-pre-wrap text-sm">{m.body}</p>
          </li>
        ))}
      </ul>
      {t.status === 'closed' ? (
        <p className="panel mt-6 p-4 text-sm text-fog">This complaint is closed. If something is still wrong, please <Link to="/app/help" className="font-semibold text-washo-300">raise a new one</Link>.</p>
      ) : (
        <div className="mt-6 space-y-3">
          <TextArea label={t.status === 'resolved' ? 'Not sorted? Write back to reopen it' : 'Write back'} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
          <Button loading={reply.isPending} disabled={!text.trim()} onClick={() => void send()}>Send</Button>
        </div>
      )}
    </div>
  );
}
