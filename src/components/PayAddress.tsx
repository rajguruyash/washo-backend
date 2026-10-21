import { Check, Plus } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import type { Address } from '../lib/types';
import { AddressSheet, addressLine } from './AddressSheet';
import { Button } from './ui/Button';

export const ADDRESS_NEEDED = 'Add your address to continue. Our specialist needs to know where to come before you pay.';

/**
 * The "Where" part of the last step of every booking. A customer signs up with just a name and adds a vehicle first, so the address is asked for HERE, right before they pay: when
 * there is none, a red alert shows and the address sheet slides up by itself, once (if they close it, the alert and the button stay, and the slider says what is missing).
 * `id="pay-address"` is where the slider scrolls to.
 */
export function PayAddress({ addresses, loaded, selectedId, onSelect, active = true }: { addresses?: Address[]; loaded: boolean; selectedId: string | null; onSelect: (id: string) => void; active?: boolean }) {
  const [manual, setManual] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const none = loaded && !addresses?.length;
  const open = manual || (active && none && !dismissed);
  return (
    <div id="pay-address" className="p-5">
      <p className="eyebrow">Where</p>
      {addresses?.length ? (
        <div className="mt-2 space-y-2">
          {addresses.map((a) => (
            <button key={a.id} type="button" onClick={() => onSelect(a.id)} aria-pressed={a.id === selectedId} className={cn('flex w-full items-start gap-3 rounded-2xl border p-3 text-left text-sm transition-colors', a.id === selectedId ? 'border-washo-400/60 bg-washo-500/10' : 'border-white/10 hover:border-white/20')}>
              <span className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border', a.id === selectedId ? 'border-washo-400 bg-washo-500' : 'border-white/30')}>{a.id === selectedId && <Check className="h-3 w-3" strokeWidth={3} />}</span>
              <span><span className="block font-semibold">{a.label} · {addressLine(a)}</span><span className="text-xs text-fog">Parking: {a.parking_location}</span></span>
            </button>
          ))}
        </div>
      ) : none ? (
        <p role="alert" className="mt-2 rounded-2xl border border-bad/40 bg-bad/10 p-3 text-sm font-medium text-bad">{ADDRESS_NEEDED}</p>
      ) : null}
      <Button variant={none ? 'primary' : 'glass'} size="sm" className="mt-3" icon={<Plus className="h-4 w-4" />} onClick={() => setManual(true)}>{none ? 'Add my address' : 'Add another address'}</Button>
      <AddressSheet
        open={open}
        notice={none ? ADDRESS_NEEDED : undefined}
        onClose={() => { setManual(false); setDismissed(true); }}
        onSaved={(a) => { onSelect(a.id); setManual(false); }}
      />
    </div>
  );
}
