import { Check, Trash2 } from 'lucide-react';
import { ApiError } from '../lib/http';
import { useRemovePlan } from '../lib/queries';
import HoldButton from './reactbits/HoldButton';
import { useToast } from './ui/Toast';

/**
 * React Bits Hold Button: press and hold to clear a plan from the customer's own pages (a plan started but not paid for, or one that
 * has ended). The hold is the confirmation, so there is no "are you sure?". Nothing is deleted: WASHO keeps its records, an unpaid plan's
 * checkout is stopped, and the server refuses an active membership or a payment that has come in.
 */
export function RemovePlan({ kind, id, unpaid = false, size = 'sm', onRemoved, className }: { kind: 'membership' | 'request'; id: string; unpaid?: boolean; size?: 'sm' | 'md'; onRemoved?: () => void; className?: string }) {
  const remove = useRemovePlan();
  const toast = useToast();
  return (
    <HoldButton
      size={size}
      holdTime={1400}
      resetAfter={1600}
      radius={12}
      backgroundColor="rgba(255,255,255,0.07)"
      textColor="#c4cde0"
      fillColor="#e5484d"
      fillTextColor="#ffffff"
      icon={<Trash2 className="h-4 w-4" aria-hidden />}
      doneIcon={<Check className="h-4 w-4" aria-hidden />}
      doneLabel="Removed"
      disabled={remove.isPending}
      className={className}
      onHold={() => {
        // (a promise, not mutate's own callbacks: those are dropped when the plan's card disappears from the list, which is exactly what success does)
        remove
          .mutateAsync({ kind, id })
          .then(() => {
            toast.success(unpaid ? 'Plan removed. Nothing was charged.' : 'Removed from your pages.');
            onRemoved?.();
          })
          .catch((err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove this. Please try again.'));
      }}
    >
      Hold to remove
    </HoldButton>
  );
}
