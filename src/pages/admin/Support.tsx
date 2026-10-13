import { Camera, LifeBuoy, Loader2, MessageSquare, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorState } from '../../components/EmptyState';
import { SupportPictures } from '../../components/SupportPictures';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select, TextArea } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { prettyPhone } from '../../lib/format';
import { compressImage } from '../../lib/image';
import { uploadSupportPicture, useAdminAction, useAdminSupport, useAdminSupportTicket } from '../../lib/queries';
import { ADMIN_STATUS_LABEL as STATUS_LABEL, CATEGORY_LABEL, STATUS_TONE } from '../../lib/support';
import type { TicketStatus } from '../../lib/types';
import { Loading, errText } from './shared';


const MAX_PICTURES = 4;
const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

function Thread({ id, canReply, onClose }: { id: string | null; canReply: boolean; onClose: () => void }) {
  const { data, isLoading, isError, refetch } = useAdminSupportTicket(id);
  const act = useAdminAction();
  const toast = useToast();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<TicketStatus | ''>('');
  // Pictures added to the reply being written: stored as soon as they are chosen, shown to the customer only when the reply is sent.
  const [pics, setPics] = useState<{ id: string; url: string | null }[]>([]);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const t = data?.ticket;
  const addPictures = async (files: FileList | null) => {
    if (!files?.length || !id) return;
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, MAX_PICTURES - pics.length)) {
        try {
          const added = await uploadSupportPicture(id, await compressImage(file));
          setPics((cur) => [...cur, added]);
        } catch (e) { toast.error(errText(e)); }
      }
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = '';
    }
  };
  const send = async () => {
    try {
      await act.mutateAsync({ path: `support/${id}/reply`, body: { message: text.trim(), ...(status ? { status } : {}), ...(pics.length ? { picture_ids: pics.map((p) => p.id) } : {}) } });
      toast.success(pics.length ? 'Reply sent with your pictures. The customer sees it from "Agent".' : 'Reply sent. The customer sees it from "Agent".');
      setText('');
      setStatus('');
      setPics([]);
    } catch (e) { toast.error(errText(e)); }
  };
  const setTo = async (s: TicketStatus) => {
    try { await act.mutateAsync({ path: `support/${id}/status`, body: { status: s } }); toast.success(`Marked ${STATUS_LABEL[s].toLowerCase()}`); } catch (e) { toast.error(errText(e)); }
  };
  return (
    <Sheet open={Boolean(id)} onClose={onClose} size="lg" title={t ? `${t.reference_code} · ${t.subject}` : 'Complaint'}
      description={t ? `${t.customer_name ?? 'Customer'}${t.customer_phone ? ` · ${prettyPhone(t.customer_phone)}` : ''}${t.booking_reference ? ` · about wash ${t.booking_reference}` : ''}` : undefined}
      footer={canReply && t && t.status !== 'closed' ? (
        <div className="space-y-3">
          <TextArea label="Your reply" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="Say what you did, or what happens next." />
          <div className="flex flex-wrap items-center gap-2">
            {pics.map((p, i) => (
              <span key={p.id} className="relative h-16 w-16 overflow-hidden rounded-xl border border-white/10">
                {p.url ? <img src={p.url} alt={`Picture ${i + 1} to send`} className="h-full w-full object-cover" /> : <span className="grid h-full w-full place-items-center text-xs text-fog">Added</span>}
                <button type="button" onClick={() => setPics((cur) => cur.filter((x) => x.id !== p.id))} aria-label={`Remove picture ${i + 1}`} className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white hover:bg-bad"><X className="h-3 w-3" /></button>
              </span>
            ))}
            <input ref={picker} type="file" accept="image/*" multiple className="sr-only" aria-label="Add pictures to this reply" disabled={uploading || pics.length >= MAX_PICTURES} onChange={(e) => void addPictures(e.target.files)} />
            <Button size="sm" variant="glass" disabled={uploading || pics.length >= MAX_PICTURES} icon={uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} onClick={() => picker.current?.click()}>{uploading ? 'Adding…' : pics.length ? 'Add another picture' : 'Add pictures'}</Button>
            <span className="text-xs text-fog">{pics.length}/{MAX_PICTURES} · the customer sees them with this reply</span>
          </div>
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <Select label="Then mark it" value={status} onChange={(e) => setStatus(e.target.value as TicketStatus | '')}>
              <option value="">Leave as it is (in progress)</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed (customer cannot reply)</option>
            </Select>
            <Button loading={act.isPending} disabled={!text.trim() || uploading} onClick={() => void send()}>Send reply</Button>
          </div>
        </div>
      ) : undefined}>
      {isError ? <ErrorState onRetry={() => void refetch()} /> : isLoading || !t ? <Loading /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
            <Badge tone="slate">{CATEGORY_LABEL[t.category]}</Badge>
            <span className="text-xs text-fog">Opened {when(t.created_at)}</span>
            {canReply && t.status !== 'closed' && t.status !== 'resolved' && <Button size="sm" variant="glass" className="ml-auto" loading={act.isPending} onClick={() => void setTo('resolved')}>Mark resolved</Button>}
            {canReply && t.status === 'resolved' && <Button size="sm" variant="glass" className="ml-auto" loading={act.isPending} onClick={() => void setTo('closed')}>Close it</Button>}
          </div>
          <ul className="space-y-3">
            {data!.messages.map((m) => (
              <li key={m.id} className={m.from_admin ? 'ml-6 rounded-2xl rounded-tr-md border border-washo-500/30 bg-washo-500/10 p-3.5' : 'mr-6 rounded-2xl rounded-tl-md border border-white/10 bg-white/[0.04] p-3.5'}>
                <p className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-fog"><span className="font-semibold text-mist">{m.from_admin ? `Agent${m.author ? ` (${m.author})` : ''}` : (t.customer_name ?? 'Customer')}</span><span>{when(m.created_at)}</span></p>
                <p className="mt-1.5 whitespace-pre-wrap text-sm">{m.body}</p>
                <SupportPictures pictures={m.attachments} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
}

/** Complaints from customers, in one place. Answer them here; the customer sees the reply in their app. */
export default function Support({ canReply }: { canReply: boolean }) {
  const [status, setStatus] = useState<TicketStatus | 'all'>('open');
  const { data, isLoading, isError, refetch } = useAdminSupport(status);
  // A complaint found with the master search arrives as ?ticket=<id> and opens at once.
  const [params, setParams] = useSearchParams();
  const wanted = params.get('ticket');
  const [open, setOpen] = useState<string | null>(wanted);
  useEffect(() => { if (wanted) setOpen(wanted); }, [wanted]);
  const close = () => { setOpen(null); if (wanted) setParams((p) => { p.delete('ticket'); return p; }, { replace: true }); };
  return (
    <div className="space-y-4">
      <Segmented label="Complaint status" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'in_progress', label: 'In progress' }, { value: 'resolved', label: 'Resolved' }, { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' }]} />
      {isError ? <ErrorState onRetry={() => void refetch()} /> : isLoading ? <Loading /> : !data?.length ? (
        <div className="panel p-8 text-center text-fog"><LifeBuoy className="mx-auto mb-2 h-6 w-6" aria-hidden />Nothing here. Customers raise complaints from Account → Help.</div>
      ) : (
        <ul className="space-y-2">
          {data.map((t) => (
            <li key={t.id}>
              <button onClick={() => setOpen(t.id)} className="glass flex w-full flex-wrap items-center gap-x-5 gap-y-2 p-4 text-left transition-colors hover:border-washo-400/40">
                <div className="w-24 shrink-0"><p className="text-sm font-bold">{t.reference_code}</p><p className="text-xs text-fog">{when(t.updated_at)}</p></div>
                <div className="min-w-0 flex-1"><p className="truncate font-semibold">{t.subject}</p><p className="truncate text-xs text-fog">{t.customer_name}{t.customer_phone ? ` · ${prettyPhone(t.customer_phone)}` : ''} · {CATEGORY_LABEL[t.category]}{t.booking_reference ? ` · ${t.booking_reference}` : ''}</p></div>
                <span className="flex items-center gap-1.5 text-xs text-fog"><MessageSquare className="h-3.5 w-3.5" aria-hidden />{t.messages}{t.last_from_admin === false && t.status !== 'closed' && t.status !== 'resolved' && <Badge tone="amber">Waiting for you</Badge>}</span>
                <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Thread key={open ?? 'none'} id={open} canReply={canReply} onClose={close} />
    </div>
  );
}
