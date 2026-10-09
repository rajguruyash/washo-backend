import { ApiError } from '../../lib/http';
import { Button } from '../../components/ui/Button';
import { Sheet } from '../../components/ui/Sheet';
import { Skeleton } from '../../components/ui/Skeleton';
import type { ReactNode } from 'react';

export const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
export const Loading = () => <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>;

/** "Are you sure?" for the things that are easy to do by accident. Nothing here deletes: it archives, and says so. */
export function ConfirmSheet({
  open, onClose, title, description, confirmLabel, loading, tone = 'primary', onConfirm, children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  confirmLabel: string;
  loading?: boolean;
  tone?: 'primary' | 'danger';
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Sheet open={open} onClose={onClose} locked={loading} size="sm" title={title} description={description}
      footer={<div className="grid grid-cols-2 gap-3"><Button variant="glass" disabled={loading} onClick={onClose}>Not now</Button><Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button></div>}>
      {children ?? <span />}
    </Sheet>
  );
}

/** ₹ typed by a person -> paise. Returns null when it is not a sensible amount. */
export function rupeesToCents(input: string): number | null {
  const v = Number(input.replace(/[^0-9.]/g, ''));
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
}

/** "7.5" -> 750 basis points. */
export function percentToBp(input: string): number | null {
  const v = Number(input.replace(/[^0-9.]/g, ''));
  return input.trim() !== '' && Number.isFinite(v) ? Math.round(v * 100) : null;
}

/** An on/off switch (a real button with role=switch, so it works with a keyboard and a screen reader). */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${on ? 'border-ok/40 bg-ok/70' : 'border-white/15 bg-white/10'}`}
    >
      <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${on ? 'left-[1.375rem]' : 'left-0.5'}`} />
    </button>
  );
}
