import { ArrowRight, LifeBuoy, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Select, TextArea } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { prettyDate } from '../../lib/format';
import { ApiError } from '../../lib/http';
import { useBookings, useCreateTicket, useMySupport } from '../../lib/queries';
import { CUSTOMER_STATUS_TEXT as STATUS_TEXT, STATUS_TONE } from '../../lib/support';
import type { TicketCategory } from '../../lib/types';

const TOPICS: { value: TicketCategory; label: string }[] = [
  { value: 'booking', label: 'A wash or booking' },
  { value: 'specialist', label: 'The specialist' },
  { value: 'payment', label: 'A payment' },
  { value: 'refund', label: 'A refund' },
  { value: 'membership', label: 'My membership' },
  { value: 'other', label: 'Something else' },
];

/** Tell WASHO something went wrong. Answers come back here, in the app. */
export default function Help() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: tickets } = useMySupport();
  const { data: bookings } = useBookings('all');
  const create = useCreateTicket();
  const wash = params.get('booking') ?? '';
  const [form, setForm] = useState({ category: (wash ? 'booking' : 'booking') as TicketCategory, booking_id: wash, subject: '', message: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    try {
      const r = await create.mutateAsync({ category: form.category, subject: form.subject, message: form.message, booking_id: form.booking_id || null });
      toast.success(`Thank you. We have your complaint (${r.ticket.reference_code}) and will reply here.`);
      navigate(`/app/help/${r.ticket.id}`);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setErrors({ _: err instanceof ApiError ? err.message : 'Something went wrong. Please try again.' });
    }
  };

  return (
    <>
      <PageHeader title="Help" subtitle="Something went wrong with a wash, a payment or a specialist? Tell us here and we will answer in the app. For anything urgent, call 86688 90147." />
      <div className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={(e) => void submit(e)} className="glass space-y-4 p-6" noValidate>
          <h2 className="flex items-center gap-2 text-lg font-bold"><LifeBuoy className="h-5 w-5 text-washo-300" /> Tell us what happened</h2>
          <Select label="What is it about?" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as TicketCategory })} error={errors.category}>
            {TOPICS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          {!!bookings?.length && (
            <Select label="Which wash?" optional value={form.booking_id} onChange={(e) => setForm({ ...form, booking_id: e.target.value })}>
              <option value="">Not about one wash</option>
              {bookings.slice(0, 40).map((b) => <option key={b.id} value={b.id}>{prettyDate(b.scheduled_date)} · {b.service_name} · {b.registration_number}</option>)}
            </Select>
          )}
          <Input label="In a few words" value={form.subject} maxLength={120} onChange={(e) => setForm({ ...form, subject: e.target.value })} error={errors.subject} placeholder="The specialist did not come" />
          <TextArea label="What happened?" value={form.message} maxLength={2000} onChange={(e) => setForm({ ...form, message: e.target.value })} error={errors.message} placeholder="Tell us in your own words, with the day and time if you can." />
          {errors._ && <p role="alert" className="text-sm text-bad">{errors._}</p>}
          <Button type="submit" size="lg" full loading={create.isPending} iconRight={<ArrowRight className="h-5 w-5" />} disabled={form.subject.trim().length < 3 || form.message.trim().length < 5}>Send to WASHO</Button>
        </form>

        <section aria-label="Your complaints" className="space-y-3">
          <h2 className="text-lg font-bold">Your complaints</h2>
          {!tickets?.length ? <p className="panel p-6 text-sm text-fog">You have not raised any. Hopefully you never need to.</p> : (
            <ul className="space-y-2">
              {tickets.map((t) => (
                <li key={t.id}>
                  <Link to={`/app/help/${t.id}`} className="glass flex items-center gap-3 p-4 transition-colors hover:border-washo-400/40">
                    <MessageCircle className="h-5 w-5 shrink-0 text-washo-300" aria-hidden />
                    <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{t.subject}</span><span className="block text-xs text-fog">{t.reference_code} · {prettyDate(t.created_at.slice(0, 10))}</span></span>
                    {t.last_from_admin && t.status !== 'closed' && <Badge tone="green">WASHO replied</Badge>}
                    <Badge tone={STATUS_TONE[t.status]}>{STATUS_TEXT[t.status]}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
