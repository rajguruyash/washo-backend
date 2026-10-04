import { percent, rupees } from '../lib/format';
import type { QuoteBreakdown } from '../lib/types';

const Row = ({ label, value, sub, tone, strong }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn'; strong?: boolean }) => (
  <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
    <div className="min-w-0">
      <p className={strong ? 'font-bold' : 'text-mist'}>{label}</p>
      {sub && <p className="mt-0.5 text-xs text-fog">{sub}</p>}
    </div>
    <p className={`shrink-0 tabular-nums ${strong ? 'font-display text-xl font-extrabold' : 'font-semibold'} ${tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : ''}`}>{value}</p>
  </div>
);

/**
 * WASHO's approved price with every line shown. Nothing is hidden: each service, each discount (with its percentage),
 * the discount cap when it applies, and any adjustment WASHO made with the reason it gave.
 */
export function QuoteBreakdownView({ q }: { q: QuoteBreakdown }) {
  return (
    <div className="divide-y divide-white/[0.07]">
      {q.lines.map((l) => (
        <Row key={l.name} label={l.name} sub={`${l.quantity} washes × ${rupees(l.unit_cents)}`} value={rupees(l.line_cents)} />
      ))}
      <Row label="Subtotal" value={rupees(q.subtotal_cents)} />
      {q.frequency_discount.cents > 0 && (
        <Row label={`Frequency discount (${percent(q.frequency_discount.bp)})`} sub={q.frequency_discount.label ?? undefined} value={`−${rupees(q.frequency_discount.cents)}`} tone="ok" />
      )}
      {q.duration_discount.cents > 0 && (
        <Row label={`Duration discount (${percent(q.duration_discount.bp)})`} sub={q.duration_discount.label ?? undefined} value={`−${rupees(q.duration_discount.cents)}`} tone="ok" />
      )}
      {q.cap.applied && (
        <Row label={`Discount cap (max ${percent(q.cap.max_bp)})`} sub="Combined discounts never exceed this" value={`+${rupees(q.cap.adjustment_cents)}`} tone="warn" />
      )}
      {q.adjustment.cents !== 0 && (
        <Row
          label="Adjustment by WASHO"
          sub={q.adjustment.reason ?? undefined}
          value={`${q.adjustment.cents < 0 ? '−' : '+'}${rupees(Math.abs(q.adjustment.cents))}`}
          tone={q.adjustment.cents < 0 ? 'ok' : 'warn'}
        />
      )}
      <Row label="Total to pay" value={rupees(q.final_cents)} strong />
    </div>
  );
}
