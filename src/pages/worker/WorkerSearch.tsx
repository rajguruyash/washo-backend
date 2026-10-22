import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { formatPlate, friendlyDay, prettyPhone } from '../../lib/format';
import { slotLabel } from '../../lib/slots';
import { staffStatus } from '../../lib/status';
import type { PoolWash, WorkerWash } from '../../lib/types';
import { queueTab, type QueueTab } from '../../lib/workerQueue';
import { matchesAll, poolFields, queueFields } from '../../lib/workerSearch';

const GROUP: Record<QueueTab, string> = { today: 'Today', overdue: 'Overdue', in_progress: 'In progress', upcoming: 'Upcoming', completed: 'Completed', changed: 'Cancelled / moved' };
const ORDER: QueueTab[] = ['today', 'overdue', 'in_progress', 'upcoming', 'completed', 'changed'];
const PER_GROUP = 5;

/**
 * One search box for everything a specialist can see: their own washes in every tab (by customer name, mobile number, number plate, building, society, flat, parking spot,
 * service or reference) and the unclaimed washes in Available. A wash of theirs opens its page; an unclaimed one opens its details with a Claim button. Press / to jump to it.
 */
export function WorkerSearch({ all, pool, onPool }: { all: WorkerWash[]; pool: PoolWash[]; onPool: (p: PoolWash) => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const q = text.trim();

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
    if (q.length < 2) return [];
    const out: { key: string; title: string; rows: { id: string; main: string; sub: string; tail: React.ReactNode; pick: () => void }[] }[] = [];
    for (const b of ORDER) {
      const rows = all
        .filter((w) => queueTab(w) === b && matchesAll(q, queueFields(w, friendlyDay(w.scheduled_date))))
        .slice(0, PER_GROUP)
        .map((w) => ({
          id: w.booking_id,
          main: `${w.service_name} · ${friendlyDay(w.scheduled_date)}, ${slotLabel(w.time_slot)}`,
          sub: [w.customer_name, w.registration_number && formatPlate(w.registration_number), w.building_block && `Block ${w.building_block}`, w.society_name, w.customer_phone && prettyPhone(w.customer_phone)].filter(Boolean).join(' · ') || w.reference_code,
          tail: <Badge tone={w.is_overdue ? 'red' : staffStatus[w.status].tone}>{w.is_overdue ? 'Overdue' : staffStatus[w.status].label}</Badge>,
          pick: () => navigate(`/worker/washes/${w.booking_id}`),
        }));
      if (rows.length) out.push({ key: b, title: GROUP[b], rows });
    }
    const avail = pool
      .filter((p) => matchesAll(q, poolFields(p, friendlyDay(p.scheduled_date))))
      .slice(0, PER_GROUP)
      .map((p) => ({
        id: p.booking_id,
        main: `${p.service_name} · ${friendlyDay(p.scheduled_date)}, ${slotLabel(p.time_slot)}`,
        sub: [p.vehicle_type.toUpperCase(), p.society_name, p.building_block && `Block ${p.building_block}`].filter(Boolean).join(' · '),
        tail: <Badge tone="amber">Not claimed</Badge>,
        pick: () => onPool(p),
      }));
    if (avail.length) out.push({ key: 'available', title: 'Available', rows: avail });
    return out;
  }, [q, all, pool, navigate, onPool]);

  const choose = (pick: () => void) => { setOpen(false); setText(''); input.current?.blur(); pick(); };
  const first = groups[0]?.rows[0];

  return (
    <div ref={box} className="relative mb-4">
      <label htmlFor="worker-search" className="sr-only">Search your washes</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fog" aria-hidden />
        <input
          id="worker-search"
          ref={input}
          type="search"
          value={text}
          autoComplete="off"
          placeholder="Search name, plate, building, society, reference…"
          onFocus={() => setOpen(true)}
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); input.current?.blur(); } if (e.key === 'Enter' && first) { e.preventDefault(); choose(first.pick); } }}
          className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.05] pl-10 pr-4 text-sm text-white placeholder:text-fog focus:border-washo-400/60 focus:outline-none focus:ring-2 focus:ring-washo-400/30"
        />
      </div>
      {open && q.length >= 2 && (
        <div role="listbox" aria-label="Search results" className="absolute left-0 right-0 z-40 mt-2 max-h-[60vh] overflow-y-auto rounded-2xl border border-white/10 bg-ink-900/95 p-2 shadow-2xl backdrop-blur-xl">
          {!groups.length ? <p className="p-4 text-sm text-fog">Nothing matches &ldquo;{q}&rdquo;.</p> : groups.map((g) => (
            <section key={g.key} aria-label={g.title} className="mb-1 last:mb-0">
              <h3 className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-fog">{g.title}</h3>
              <ul>
                {g.rows.map((r) => (
                  <li key={r.id}>
                    <button type="button" role="option" aria-selected={false} onClick={() => choose(r.pick)} className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none">
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
