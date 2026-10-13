import { CalendarCheck, LifeBuoy, Loader2, Repeat, Search, User } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { cn } from '../../lib/cn';
import { formatPlate, prettyDate, prettyPhone } from '../../lib/format';
import { useAdminSearch } from '../../lib/queries';
import { slotLabel } from '../../lib/slots';
import { payKind, payLabel, staffStatus } from '../../lib/status';
import { ADMIN_STATUS_LABEL, STATUS_TONE } from '../../lib/support';

export type SearchPick = { kind: 'customer' | 'wash' | 'membership' | 'ticket'; id: string };

/**
 * One box for everything: a customer (name, mobile number, email, number plate), a wash (reference, customer, plate, society, flat), a membership or a complaint. Press / to
 * jump to it from anywhere on the page. Each part only appears if the admin's role may look at it.
 */
export function AdminSearch({ onPick }: { onPick: (pick: SearchPick) => void }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  const { data, isFetching, isError } = useAdminSearch(q);

  // close when clicking elsewhere; "/" jumps here unless the admin is typing somewhere
  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const slash = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '') && !el?.isContentEditable) { e.preventDefault(); input.current?.focus(); setOpen(true); }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', slash);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', slash); };
  }, []);

  const groups = useMemo(() => {
    if (!data || q.length < 2) return [];
    return [
      { key: 'customers', title: 'Customers', icon: User, rows: data.customers.map((c) => ({
        pick: { kind: 'customer', id: c.id } as SearchPick, id: c.id,
        main: <>{c.full_name ?? 'Customer'}{c.archived && <Badge tone="slate" className="ml-2 align-middle">Archived</Badge>}</>,
        sub: [c.phone ? prettyPhone(c.phone) : null, c.plates ? c.plates.split(', ').map(formatPlate).join(', ') : null, c.email].filter(Boolean).join(' · '),
        tail: null as React.ReactNode,
      })) },
      { key: 'washes', title: 'Washes', icon: CalendarCheck, rows: data.washes.map((w) => ({
        pick: { kind: 'wash', id: w.id } as SearchPick, id: w.id,
        main: <>{w.reference_code} <span className="font-normal text-fog">· {prettyDate(w.scheduled_date)}, {slotLabel(w.time_slot)} · {w.service_name}</span></>,
        sub: [w.customer_name, w.customer_phone ? prettyPhone(w.customer_phone) : null, formatPlate(w.registration_number)].filter(Boolean).join(' · '),
        tail: <span className="flex shrink-0 items-center gap-1.5"><Badge tone={payKind[w.payment_kind]?.tone ?? 'slate'}>{w.payment_kind ? payLabel(w.payment_kind, w.payment_provider) : 'Paid'}</Badge><Badge tone={staffStatus[w.status].tone}>{staffStatus[w.status].label}</Badge></span>,
      })) },
      { key: 'memberships', title: 'Memberships', icon: Repeat, rows: data.memberships.map((m) => ({
        pick: { kind: 'membership', id: m.id } as SearchPick, id: m.id,
        main: <>{m.reference_code ?? 'Membership'} <span className="font-normal text-fog">· {m.customer_name}</span></>,
        sub: [m.customer_phone ? prettyPhone(m.customer_phone) : null, m.registration_number ? formatPlate(m.registration_number) : null, m.vehicle_model].filter(Boolean).join(' · '),
        tail: <Badge tone={m.status === 'active' ? 'green' : 'slate'}>{m.status === 'active' ? 'On' : m.status}</Badge>,
      })) },
      { key: 'tickets', title: 'Complaints', icon: LifeBuoy, rows: data.tickets.map((t) => ({
        pick: { kind: 'ticket', id: t.id } as SearchPick, id: t.id,
        main: <>{t.reference_code} <span className="font-normal text-fog">· {t.subject}</span></>,
        sub: [t.customer_name, t.customer_phone ? prettyPhone(t.customer_phone) : null].filter(Boolean).join(' · '),
        tail: <Badge tone={STATUS_TONE[t.status]}>{ADMIN_STATUS_LABEL[t.status]}</Badge>,
      })) },
    ].filter((g) => g.rows.length);
  }, [data, q]);

  const choose = (p: SearchPick) => { setOpen(false); setText(''); setQ(''); input.current?.blur(); onPick(p); };
  const first = groups[0]?.rows[0];

  return (
    <div ref={box} className="relative w-full sm:w-[26rem]">
      <label className="sr-only" htmlFor="admin-search">Search everything</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fog" aria-hidden />
        <input
          id="admin-search"
          ref={input}
          type="search"
          value={text}
          autoComplete="off"
          placeholder="Search customers, washes, plates, complaints…   ( / )"
          onFocus={() => setOpen(true)}
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); input.current?.blur(); } if (e.key === 'Enter' && first) { e.preventDefault(); choose(first.pick); } }}
          className="h-11 w-full rounded-2xl border border-white/10 bg-white/[0.05] pl-10 pr-10 text-sm text-white placeholder:text-fog focus:border-washo-400/60 focus:outline-none focus:ring-2 focus:ring-washo-400/30"
        />
        {isFetching && <Loader2 className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-fog" aria-label="Searching" />}
      </div>
      {open && q.length >= 2 && (
        <div role="listbox" aria-label="Search results" className="absolute left-0 right-0 z-50 mt-2 max-h-[70vh] overflow-y-auto rounded-2xl border border-white/10 bg-ink-900/95 p-2 shadow-2xl backdrop-blur-xl sm:left-auto sm:w-[34rem] sm:max-w-[calc(100vw-2rem)]">
          {isError ? <p className="p-4 text-sm text-bad">Search is not available right now. Please try again.</p>
            : !groups.length ? <p className="p-4 text-sm text-fog">{isFetching ? 'Searching…' : `Nothing matches "${q}".`}</p>
            : groups.map((g) => (
              <section key={g.key} aria-label={g.title} className="mb-1 last:mb-0">
                <h3 className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-fog"><g.icon className="h-3.5 w-3.5" aria-hidden />{g.title}</h3>
                <ul>
                  {g.rows.map((r) => (
                    <li key={r.id}>
                      <button type="button" role="option" aria-selected={false} onClick={() => choose(r.pick)} className={cn('flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none')}>
                        <span className="min-w-0"><span className="block truncate text-sm font-semibold">{r.main}</span>{r.sub && <span className="block truncate text-xs text-fog">{r.sub}</span>}</span>
                        {r.tail}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      )}
    </div>
  );
}
